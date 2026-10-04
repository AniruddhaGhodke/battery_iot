/**
 * Read side of the database, used by the route handlers.
 *
 * Every query is bounded so it costs the same at 1 pack or 100, and with a
 * week of history or a year: the pack list reads pack_latest (one row per
 * pack), and history never returns more than ~MAX_POINTS points, reading the
 * hourly/daily roll-ups instead of raw rows for long ranges.
 */

import { config } from "./config";
import { sql } from "./db";
import type { Status } from "./ingest-status";
import type { Reading } from "./telemetry";

export type PackSummary = {
  packId: string;
  label: string | null;
  site: string | null;
  online: boolean;
  lastSeen: number;
  messages: number;
  seriesCount: number;
  voltage: number | null;
  current: number | null;
  soc: number | null;
  spreadMv: number | null;
  activeAlarms: string[];
};

export type PackDetail = {
  packId: string;
  label: string | null;
  site: string | null;
  online: boolean;
  messages: number;
  firstSeen: number;
  lastSeen: number;
  latest: Reading;
};

/** One chart point. For bucketed data, the value is the average over the bucket. */
export type Point = {
  t: number;
  voltage: number | null;
  voltageMin?: number | null;
  voltageMax?: number | null;
  current: number | null;
  currentMin?: number | null;
  currentMax?: number | null;
  power: number | null;
  soc: number | null;
  cellMin: number | null;
  cellMax: number | null;
  spreadMv: number | null;
  spreadMax?: number | null;
  maxTemp: number | null;
};

export type History = {
  from: number;
  to: number;
  /** "raw", "raw:<bucket>", "1h:<bucket>" or "1d:<bucket>" - where the points came from. */
  source: string;
  bucketS: number;
  points: Point[];
};

const MAX_POINTS = 800;
const RAW_MAX_SPAN_S = 3 * 86_400; // aggregate raw rows up to 3 days, roll-ups beyond
// Bucket sizes a chart can use, in seconds.
const BUCKETS = [
  15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400,
  172_800, 604_800,
];

const ms = (col: string) => sql.unsafe(`(extract(epoch from ${col}) * 1000)::float8`);

export async function listPacks(): Promise<PackSummary[]> {
  const rows = await sql<Omit<PackSummary, "online">[]>`
    select
      p.device_id                          as "packId",
      p.label,
      p.site,
      ${ms("l.received_at")}               as "lastSeen",
      l.messages::float8                   as messages,
      (l.reading->>'seriesCount')::int     as "seriesCount",
      (l.reading->>'voltage')::float8      as voltage,
      (l.reading->>'current')::float8      as current,
      (l.reading->>'soc')::float8          as soc,
      (l.reading->>'spreadMv')::float8     as "spreadMv",
      coalesce(l.reading->'activeAlarms', '[]'::jsonb) as "activeAlarms"
    from packs p
    join pack_latest l on l.pack_id = p.id
    where p.enabled
    order by p.device_id`;
  const now = Date.now();
  return rows.map((r) => ({ ...r, online: now - r.lastSeen < config.staleAfterS * 1000 }));
}

export async function getPack(deviceId: string): Promise<PackDetail | null> {
  const [row] = await sql<Omit<PackDetail, "online">[]>`
    select
      p.device_id                 as "packId",
      p.label,
      p.site,
      l.messages::float8          as messages,
      ${ms("l.first_seen")}       as "firstSeen",
      ${ms("l.received_at")}      as "lastSeen",
      l.reading                   as latest
    from packs p
    join pack_latest l on l.pack_id = p.id
    where p.device_id = ${deviceId} and p.enabled`;
  if (!row) return null;
  return { ...row, online: Date.now() - row.lastSeen < config.staleAfterS * 1000 };
}

async function packDbId(deviceId: string): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    select id from packs where device_id = ${deviceId} and enabled`;
  return row?.id ?? null;
}

const RAW_POINT = sql`
  ${ms("ts")}                        as t,
  voltage::numeric::float8           as voltage,  -- via numeric: 52.8, not 52.79999923706055
  current::numeric::float8           as current,
  power::numeric::float8             as power,
  soc::numeric::float8               as soc,
  cell_min_mv / 1000.0::float8       as "cellMin",
  cell_max_mv / 1000.0::float8       as "cellMax",
  spread_mv::float8                  as "spreadMv",
  temp_max_dc / 10.0::float8         as "maxTemp"`;

/** The last `limit` raw readings (at most one day back), oldest first. */
export async function getRecent(deviceId: string, limit: number): Promise<Point[] | null> {
  const id = await packDbId(deviceId);
  if (id === null) return null;
  const rows = await sql<Point[]>`
    select ${RAW_POINT}
    from readings
    where pack_id = ${id} and ts > now() - interval '1 day'
    order by ts desc
    limit ${limit}`;
  return rows.reverse();
}

function pickBucket(spanS: number): number {
  return BUCKETS.find((b) => spanS / b <= MAX_POINTS) ?? BUCKETS.at(-1)!;
}

export async function getHistory(deviceId: string, from: number, to: number): Promise<History | null> {
  const id = await packDbId(deviceId);
  if (id === null) return null;

  const spanS = Math.max(1, (to - from) / 1000);
  const fromD = new Date(from);
  const toD = new Date(to);
  const rawAvailable = from > Date.now() - (config.rawRetentionDays - 1) * 86_400_000;

  // Short range: every raw reading (5 s data, at most MAX_POINTS of them).
  if (rawAvailable && spanS <= MAX_POINTS * 5) {
    const points = await sql<Point[]>`
      select ${RAW_POINT}
      from readings
      where pack_id = ${id} and ts >= ${fromD} and ts < ${toD}
      order by ts
      limit ${MAX_POINTS * 4}`;
    return { from, to, source: "raw", bucketS: 0, points: thin(points) };
  }

  const bucketS = pickBucket(spanS);
  const bucket = `${bucketS} seconds`;

  // Up to 3 days: aggregate raw rows, so short ranges keep minute detail.
  if (rawAvailable && spanS <= RAW_MAX_SPAN_S && bucketS < 3600) {
    const points = await sql<Point[]>`
      select
        ${ms(`time_bucket('${bucket}'::interval, ts)`)} as t,
        avg(voltage)::float8            as voltage,
        min(voltage)::float8            as "voltageMin",
        max(voltage)::float8            as "voltageMax",
        avg(current)::float8            as current,
        min(current)::float8            as "currentMin",
        max(current)::float8            as "currentMax",
        avg(power)::float8              as power,
        avg(soc)::float8                as soc,
        min(cell_min_mv) / 1000.0::float8 as "cellMin",
        max(cell_max_mv) / 1000.0::float8 as "cellMax",
        avg(spread_mv)::float8          as "spreadMv",
        max(spread_mv)::float8          as "spreadMax",
        max(temp_max_dc) / 10.0::float8 as "maxTemp"
      from readings
      where pack_id = ${id} and ts >= ${fromD} and ts < ${toD}
      group by 1
      order by 1`;
    return { from, to, source: `raw:${bucketS}s`, bucketS, points };
  }

  // Longer: re-bucket the hourly (or daily) roll-up, weighting averages by n.
  const view = bucketS >= 86_400 ? "readings_1d" : "readings_1h";
  const b = Math.max(bucketS, view === "readings_1d" ? 86_400 : 3600);
  const points = await sql<Point[]>`
    select
      ${ms(`time_bucket('${b} seconds'::interval, bucket)`)} as t,
      (sum(voltage_avg * n) / sum(n))::float8  as voltage,
      min(voltage_min)::float8                 as "voltageMin",
      max(voltage_max)::float8                 as "voltageMax",
      (sum(current_avg * n) / sum(n))::float8  as current,
      min(current_min)::float8                 as "currentMin",
      max(current_max)::float8                 as "currentMax",
      (sum(power_avg * n) / sum(n))::float8    as power,
      (sum(soc_avg * n) / sum(n))::float8      as soc,
      min(cell_min_mv) / 1000.0::float8        as "cellMin",
      max(cell_max_mv) / 1000.0::float8        as "cellMax",
      (sum(spread_avg * n) / sum(n))::float8   as "spreadMv",
      max(spread_max)::float8                  as "spreadMax",
      max(temp_max_dc) / 10.0::float8          as "maxTemp"
    from ${sql(view)}
    where pack_id = ${id} and bucket >= ${fromD} and bucket < ${toD}
    group by 1
    order by 1`;
  return { from, to, source: `${view === "readings_1d" ? "1d" : "1h"}:${b}s`, bucketS: b, points };
}

/** Evenly drop points down to MAX_POINTS (only hit when readings are faster than 5 s). */
function thin(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const step = points.length / MAX_POINTS;
  return Array.from({ length: MAX_POINTS }, (_, i) => points[Math.floor(i * step)]);
}

export async function dbHealth(): Promise<Status["db"]> {
  try {
    const [row] = await sql<{ size: number; readings: number }[]>`
      select
        pg_database_size(current_database())::float8 as size,
        hypertable_size('readings')::float8           as readings`;
    return { ok: true, error: null, sizeBytes: row.size, readingsBytes: row.readings };
  } catch (e) {
    return { ok: false, error: (e as Error).message, sizeBytes: null, readingsBytes: null };
  }
}
