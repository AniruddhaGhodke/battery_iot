/**
 * Buffers accepted readings and writes them to the database in batches.
 *
 * One multi-row insert per second instead of one per message: at 100 packs
 * every 5 s that is 1 statement/s instead of 20, and it keeps up far beyond
 * that. If the database is unreachable the buffer keeps growing (up to
 * bufferMaxRows, oldest dropped first) and is written once it is back.
 */

import type { Sql } from "postgres";
import { ALARM_KEYS, type Reading } from "../lib/telemetry.ts";

type Pending = { packId: number; reading: Reading };

export type WriterStats = {
  buffered: number;
  written: number;
  duplicates: number;
  dropped: number;
  flushes: number;
  errors: number;
  lastWriteAt: number | null;
  lastFlushMs: number | null;
  lastError: string | null;
};

const COLUMNS = [
  "ts", "pack_id", "received_at", "device_at", "seq", "status",
  "voltage", "current", "power", "soc", "remaining_ah", "host_temp",
  "cells_mv", "cell_min_mv", "cell_max_mv", "spread_mv",
  "temps_dc", "temp_max_dc", "alarms",
] as const;

// 2000-01-01 .. 2100-01-01: anything outside is a clock that was never set.
const SANE_TIME = [946_684_800_000, 4_102_444_800_000];

const mv = (v: number | null) => (v === null ? null : Math.round(v * 1000));

export function toRow(packId: number, r: Reading) {
  const temps: (number | null)[] = [];
  for (const m of r.moduleTemps) temps[m.index - 1] = Math.round(m.value * 10);
  const tempsDc = Array.from(temps, (v) => v ?? null);
  const present = tempsDc.filter((v): v is number => v !== null);

  return {
    ts: new Date(r.ts),
    pack_id: packId,
    received_at: new Date(r.receivedAt),
    device_at:
      r.deviceTime !== null && r.deviceTime > SANE_TIME[0] && r.deviceTime < SANE_TIME[1]
        ? new Date(r.deviceTime)
        : null,
    seq: r.seq,
    status: r.status.slice(0, 32),
    voltage: r.voltage,
    current: r.current,
    power: r.power,
    soc: r.soc,
    remaining_ah: r.remainingAh,
    host_temp: r.hostTemp,
    cells_mv: r.cells.map((v) => Math.round(v * 1000)),
    cell_min_mv: mv(r.cellMin),
    cell_max_mv: mv(r.cellMax),
    spread_mv: r.spreadMv,
    temps_dc: tempsDc.length ? tempsDc : null,
    temp_max_dc: present.length ? Math.max(...present) : null,
    alarms: ALARM_KEYS.reduce((bits, k, i) => (r.alarms[k] ? bits | (1 << i) : bits), 0),
  };
}

export class Writer {
  private sql: Sql;
  private buffer: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private intervalMs: number;
  private maxRows: number;
  private bufferMax: number;
  readonly stats: WriterStats = {
    buffered: 0,
    written: 0,
    duplicates: 0,
    dropped: 0,
    flushes: 0,
    errors: 0,
    lastWriteAt: null,
    lastFlushMs: null,
    lastError: null,
  };

  constructor(sql: Sql, opts: { intervalMs: number; maxRows: number; bufferMax: number }) {
    this.sql = sql;
    this.intervalMs = opts.intervalMs;
    this.maxRows = opts.maxRows;
    this.bufferMax = opts.bufferMax;
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  push(packId: number, reading: Reading) {
    this.buffer.push({ packId, reading });
    this.trim();
    if (this.buffer.length >= this.maxRows) void this.flush();
  }

  /** Writes everything buffered. Used on shutdown. */
  async drain() {
    if (this.timer) clearInterval(this.timer);
    for (let i = 0; i < 20 && this.buffer.length; i++) {
      await this.flush();
      if (this.stats.lastError && this.buffer.length) break;
    }
  }

  flush(): Promise<void> {
    if (!this.flushing && this.buffer.length) {
      this.flushing = this.write().finally(() => {
        this.flushing = null;
        this.stats.buffered = this.buffer.length;
      });
    }
    return this.flushing ?? Promise.resolve();
  }

  private trim() {
    const over = this.buffer.length - this.bufferMax;
    if (over > 0) {
      this.buffer.splice(0, over);
      this.stats.dropped += over;
    }
    this.stats.buffered = this.buffer.length;
  }

  private async write() {
    const batch = this.buffer.splice(0, this.maxRows);
    const started = performance.now();
    try {
      const rows = batch.map((p) => toRow(p.packId, p.reading));

      // Newest reading and message count per pack, for pack_latest.
      const latest = new Map<number, { p: Pending; n: number; firstSeen: number; lastSeen: number }>();
      for (const p of batch) {
        const at = p.reading.receivedAt;
        const cur = latest.get(p.packId);
        if (!cur) {
          latest.set(p.packId, { p, n: 1, firstSeen: at, lastSeen: at });
        } else {
          cur.n++;
          if (p.reading.ts >= cur.p.reading.ts) cur.p = p;
          cur.firstSeen = Math.min(cur.firstSeen, at);
          cur.lastSeen = Math.max(cur.lastSeen, at);
        }
      }
      const latestRows = [...latest.entries()].map(([packId, { p, n, firstSeen, lastSeen }]) => ({
        pack_id: packId,
        ts: new Date(p.reading.ts),
        received_at: new Date(lastSeen),
        first_seen: new Date(firstSeen),
        messages: n,
        reading: p.reading as unknown as Record<string, never>,
      }));

      const inserted = await this.sql.begin(async (tx) => {
        const res = await tx`
          insert into readings ${tx(rows, ...COLUMNS)}
          on conflict do nothing`;
        await tx`
          insert into pack_latest ${tx(latestRows, "pack_id", "ts", "received_at", "first_seen", "messages", "reading")}
          on conflict (pack_id) do update set
            messages    = pack_latest.messages + excluded.messages,
            received_at = greatest(pack_latest.received_at, excluded.received_at),
            reading     = case when excluded.ts >= pack_latest.ts then excluded.reading else pack_latest.reading end,
            ts          = greatest(pack_latest.ts, excluded.ts)`;
        return res.count;
      });

      this.stats.written += inserted;
      this.stats.duplicates += batch.length - inserted;
      this.stats.flushes++;
      this.stats.lastWriteAt = Date.now();
      this.stats.lastFlushMs = Math.round(performance.now() - started);
      this.stats.lastError = null;
      if (this.buffer.length >= this.maxRows) setImmediate(() => void this.flush());
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = (e as Error).message;
      const code = (e as { code?: string }).code ?? "";
      if (/^2[23]/.test(code)) {
        // Data or constraint error: retrying the same rows fails forever and
        // blocks everything behind them. Drop this batch, keep going.
        this.stats.dropped += batch.length;
        console.warn(`[db] dropped ${batch.length} readings the database rejected (${code}): ${(e as Error).message}`);
        return;
      }
      // Connection-type error: put the batch back in front, retry next tick.
      this.buffer.unshift(...batch);
      this.trim();
      console.warn(`[db] write failed, ${this.buffer.length} readings buffered: ${(e as Error).message}`);
    }
  }
}
