/**
 * Gathers the 24 h window the diagnosis rules read (lib/diagnose.ts).
 *
 * Pack-level figures come from every stored reading; anything that needs the
 * per-cell or per-module arrays is sampled at one reading a minute, which is
 * plenty for statistics and keeps the array work off a 1 GB droplet.
 *
 * Every query is read-only and bounded by pack and time, so this cannot slow
 * the ingest write path down for long. The caller applies a timeout anyway.
 */

import type { Sql } from "postgres";
import type { CellStat, DiagnosisWindow, ModuleTemp, Stat } from "../lib/diagnose.ts";
import { ALARM_KEYS } from "../lib/telemetry.ts";

const WINDOW_HOURS = 24;
const BASELINE_DAYS = 7;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const stat = (min: unknown, max: unknown, avg: unknown): Stat => ({
  min: num(min),
  max: num(max),
  avg: num(avg),
});

/**
 * SQL that is true while `condition` holds, for counting episodes. Alarm
 * flags come from the stored bitmask; the cell checks are recomputed, since
 * they are derived rather than reported by the device.
 */
function conditionSql(sql: Sql, condition: string, spreadMv: number) {
  if (condition.startsWith("alarm:")) {
    const key = condition.slice(6) as (typeof ALARM_KEYS)[number];
    const bit = ALARM_KEYS.indexOf(key);
    if (bit < 0) return null;
    return sql`(alarms & ${1 << bit}) <> 0`;
  }
  // cell_min_mv ignores zeros (lib/telemetry.ts), so look in the array itself.
  if (condition === "cell:silent") return sql`(0 = any(cells_mv))`;
  if (condition === "cell:spread") return sql`(spread_mv >= ${spreadMv})`;
  return null;
}

export async function gatherWindow(
  sql: Sql,
  packDbId: number,
  deviceId: string,
  condition: string,
  spreadThresholdMv: number,
  now = Date.now(),
): Promise<DiagnosisWindow> {
  const to = now;
  const from = now - WINDOW_HOURS * 3_600_000;
  const since = new Date(from);
  const until = new Date(to);

  const [base, cellRows, tempRows, corr, slope, baseRow, episodes, sampleRows] = await Promise.all([
    // Pack-level figures over every stored reading in the window.
    sql<Record<string, unknown>[]>`
      select
        count(*)                      as n,
        min(voltage)   as v_min, max(voltage)   as v_max, avg(voltage)   as v_avg,
        min(current)   as i_min, max(current)   as i_max, avg(current)   as i_avg,
        min(soc)       as s_min, max(soc)       as s_max, avg(soc)       as s_avg,
        min(spread_mv) as p_min, max(spread_mv) as p_max, avg(spread_mv) as p_avg,
        min(temp_max_dc) as t_min, max(temp_max_dc) as t_max, avg(temp_max_dc) as t_avg,
        max(cardinality(cells_mv))    as series,
        count(*) filter (where gap > interval '5 minutes') as gaps
      from (
        select voltage, current, soc, spread_mv, temp_max_dc, cells_mv,
               ts - lag(ts) over (order by ts) as gap
        from readings where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until}
      ) r`,

    // Per-cell, from one reading a minute.
    sql<Record<string, unknown>[]>`
      with s as (
        select distinct on (time_bucket(interval '1 minute', ts))
               row_number() over (order by ts) as rid, cells_mv
        from readings
        where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until}
        order by time_bucket(interval '1 minute', ts), ts desc
      ),
      c as (
        select s.rid, u.idx::int as idx, u.mv
        from s, unnest(s.cells_mv) with ordinality as u(mv, idx)
      ),
      ranked as (
        select idx, mv,
               row_number() over (partition by rid order by mv asc)  as r_lo,
               row_number() over (partition by rid order by mv desc) as r_hi
        from c where mv > 0
      )
      select c.idx,
             avg(c.mv) filter (where c.mv > 0)           as mean_mv,
             min(c.mv) filter (where c.mv > 0)           as min_mv,
             max(c.mv) filter (where c.mv > 0)           as max_mv,
             count(*) filter (where c.mv = 0)            as zeros,
             coalesce(l.lo, 0)                           as lowest,
             coalesce(h.hi, 0)                           as highest
      from c
      left join (select idx, count(*) lo from ranked where r_lo = 1 group by idx) l on l.idx = c.idx
      left join (select idx, count(*) hi from ranked where r_hi = 1 group by idx) h on h.idx = c.idx
      group by c.idx, l.lo, h.hi
      order by c.idx`,

    // Per temperature channel, same sampling. 0 means "not fitted".
    sql<Record<string, unknown>[]>`
      with s as (
        select distinct on (time_bucket(interval '1 minute', ts)) temps_dc
        from readings
        where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until} and temps_dc is not null
        order by time_bucket(interval '1 minute', ts), ts desc
      )
      select u.idx::int as idx, avg(u.dc) / 10.0 as avg_c, max(u.dc) / 10.0 as max_c
      from s, unnest(s.temps_dc) with ordinality as u(dc, idx)
      where u.dc is not null and u.dc <> 0
      group by u.idx order by u.idx`,

    // Does the spread follow the load, or the state of charge?
    sql<Record<string, unknown>[]>`
      with w as (
        select current, soc, spread_mv, temp_max_dc
        from readings where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until}
      ),
      q as (
        select percentile_cont(0.75) within group (order by abs(current)) as hi,
               percentile_cont(0.25) within group (order by abs(current)) as lo
        from w where current is not null
      )
      select
        avg(w.spread_mv)   filter (where abs(w.current) >= q.hi) as sp_hi_i,
        avg(w.spread_mv)   filter (where abs(w.current) <= q.lo) as sp_lo_i,
        avg(w.spread_mv)   filter (where w.soc >= 85)            as sp_hi_soc,
        avg(w.spread_mv)   filter (where w.soc <= 25)            as sp_lo_soc,
        avg(w.temp_max_dc) filter (where abs(w.current) >= q.hi) as t_hi_i,
        avg(w.temp_max_dc) filter (where abs(w.current) <= q.lo) as t_lo_i
      from w, q`,

    // Temperature trend over the last 3 h, degC per hour.
    sql<Record<string, unknown>[]>`
      select regr_slope(temp_max_dc / 10.0, extract(epoch from ts) / 3600.0) as slope
      from readings
      where pack_id = ${packDbId} and ts >= ${new Date(to - 3 * 3_600_000)} and temp_max_dc is not null`,

    // The week before this window, from the hourly roll-up.
    sql<Record<string, unknown>[]>`
      select avg(spread_avg) as spread_avg, max(temp_max_dc) / 10.0 as temp_max_c,
             count(*) as buckets
      from readings_1h
      where pack_id = ${packDbId}
        and bucket >= ${new Date(from - BASELINE_DAYS * 86_400_000)} and bucket < ${since}`,

    countEpisodes(sql, packDbId, condition, spreadThresholdMv, since, until),

    // How many rows the per-cell figures above are based on.
    sql<{ n: string }[]>`
      select count(*)::text as n from (
        select distinct on (time_bucket(interval '1 minute', ts)) ts
        from readings where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until}
        order by time_bucket(interval '1 minute', ts), ts desc
      ) s`,
  ]);

  const b = base[0] ?? {};
  const sampleCount = num(sampleRows[0]?.n) ?? 0;

  const cells: CellStat[] = cellRows.map((r) => ({
    index: num(r.idx) ?? 0,
    meanMv: Math.round(num(r.mean_mv) ?? 0),
    minMv: Math.round(num(r.min_mv) ?? 0),
    maxMv: Math.round(num(r.max_mv) ?? 0),
    lowestCount: num(r.lowest) ?? 0,
    highestCount: num(r.highest) ?? 0,
    zeroCount: num(r.zeros) ?? 0,
  }));

  const moduleTemps: ModuleTemp[] = tempRows.map((r) => ({
    index: num(r.idx) ?? 0,
    avgC: num(r.avg_c) ?? 0,
    maxC: num(r.max_c) ?? 0,
  }));

  const c = corr[0] ?? {};
  const bl = baseRow[0] ?? {};
  const baselineBuckets = num(bl.buckets) ?? 0;
  const dc = (v: unknown) => {
    const n = num(v);
    return n === null ? null : n / 10;
  };

  return {
    packId: deviceId,
    from,
    to,
    readings: num(b.n) ?? 0,
    samples: sampleCount,
    seriesCount: num(b.series) ?? 0,
    voltage: stat(b.v_min, b.v_max, b.v_avg),
    current: stat(b.i_min, b.i_max, b.i_avg),
    soc: stat(b.s_min, b.s_max, b.s_avg),
    spreadMv: stat(b.p_min, b.p_max, b.p_avg),
    tempMaxC: { min: dc(b.t_min), max: dc(b.t_max), avg: dc(b.t_avg) },
    cells,
    moduleTemps,
    spreadAtHighCurrentMv: num(c.sp_hi_i),
    spreadAtLowCurrentMv: num(c.sp_lo_i),
    spreadAtHighSocMv: num(c.sp_hi_soc),
    spreadAtLowSocMv: num(c.sp_lo_soc),
    tempAtHighCurrentC: dc(c.t_hi_i),
    tempAtLowCurrentC: dc(c.t_lo_i),
    tempSlopeCPerHour: num(slope[0]?.slope),
    episodes,
    firstSeen: null,
    baseline: baselineBuckets
      ? {
          days: BASELINE_DAYS,
          spreadAvgMv: num(bl.spread_avg),
          tempMaxC: num(bl.temp_max_c),
        }
      : null,
    gaps: num(b.gaps) ?? 0,
  };
}

/** How many separate times the condition became true inside the window. */
async function countEpisodes(
  sql: Sql,
  packDbId: number,
  condition: string,
  spreadMv: number,
  since: Date,
  until: Date,
): Promise<number> {
  const on = conditionSql(sql, condition, spreadMv);
  if (!on) return 0;
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from (
      select ${on} as active, lag(${on}) over (order by ts) as prev
      from readings where pack_id = ${packDbId} and ts >= ${since} and ts <= ${until}
    ) t
    where t.active and (t.prev is distinct from true)`;
  return num(rows[0]?.n) ?? 0;
}
