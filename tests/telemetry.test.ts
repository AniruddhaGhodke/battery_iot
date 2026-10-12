import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderingTime, parseReading, PayloadError } from "../lib/telemetry.ts";
import { toRow, Writer } from "../ingest/writer.ts";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function payload(extra: Record<string, unknown> = {}, telemetry: Record<string, unknown> = {}) {
  return {
    device_id: "EM_PACK_16S_03",
    schema: 2,
    unix_timestamp: NOW / 1000 - 13_320, // 3.7 h behind, like the real device
    system_status: "ONLINE",
    telemetry: {
      total_voltage_v: 13.2,
      total_current_a: -2.5,
      soc_percent: 80,
      remaining_capacity_ah: 8,
      host_temp_c: 0,
      cell_voltages_v: [3.3, 3.301, 3.299, 3.3, 0, 0],
      module_temps_c: [29.2, 0, 30.1, 0],
      ...telemetry,
    },
    alarms: { over_current: false, over_discharge: true, over_charge: false, over_temperature: true, cell_string_error: false },
    ...extra,
  };
}

describe("parseReading", () => {
  it("cuts trailing padding and derives cell figures", () => {
    const r = parseReading(payload(), "P", "t", NOW);
    assert.deepEqual(r.cells, [3.3, 3.301, 3.299, 3.3]);
    assert.equal(r.seriesCount, 4);
    assert.equal(r.spreadMv, 2);
    assert.equal(r.sumMismatchV, 0);
    assert.deepEqual(r.silentCells, []);
  });

  it("flags a zero inside the string as a silent cell", () => {
    const r = parseReading(payload({}, { cell_voltages_v: [3.3, 0, 3.3, 0] }), "P", "t", NOW);
    assert.deepEqual(r.silentCells, [2]);
    assert.equal(r.sumMismatchV, null);
  });

  it("drops temperature channels reading 0", () => {
    const r = parseReading(payload(), "P", "t", NOW);
    assert.deepEqual(r.moduleTemps, [
      { index: 1, value: 29.2 },
      { index: 3, value: 30.1 },
    ]);
    assert.equal(r.hostTemp, null);
  });

  it("rejects cell voltages that would not fit the database", () => {
    assert.throws(() => parseReading(payload({}, { cell_voltages_v: [3.3, 99] }), "P", "t", NOW), PayloadError);
    assert.throws(
      () => parseReading(payload({}, { cell_voltages_v: Array(300).fill(3.3) }), "P", "t", NOW),
      PayloadError,
    );
  });

  it("drops pack figures too large for the database instead of failing the batch", () => {
    const r = parseReading(
      payload({}, { total_voltage_v: 1e300, total_current_a: -1e7, soc_percent: 1e39, remaining_capacity_ah: 1e300, host_temp_c: 1e300 }),
      "P", "t", NOW,
    );
    assert.equal(r.voltage, null);
    assert.equal(r.current, null);
    assert.equal(r.power, null);
    assert.equal(r.soc, null);
    assert.equal(r.remainingAh, null);
    assert.equal(r.hostTemp, null);
    assert.equal(r.sumMismatchV, null);
  });

  it("cleans status text Postgres would refuse (NUL, lone surrogate)", () => {
    assert.equal(parseReading(payload({ system_status: "ON\u0000LINE" }), "P", "t", NOW).status, "ONLINE");
    assert.equal(parseReading(payload({ system_status: "A\ud800B" }), "P", "t", NOW).status, "A\ufffdB");
  });

  it("files a reading from an unsynced clock under arrival time", () => {
    const r = parseReading(payload(), "P", "t", NOW);
    assert.equal(r.ts, NOW);
    assert.equal(r.clockSkewS, -13_320);
  });

  it("uses device time once the firmware says it is synced", () => {
    const r = parseReading(payload({ unix_timestamp: NOW / 1000 - 2, time_ok: true, seq: 7 }), "P", "t", NOW);
    assert.equal(r.ts, NOW - 2000);
    assert.equal(r.seq, 7);
  });
});

describe("orderingTime", () => {
  const tol = 300;
  it("ignores device time unless time_ok", () => {
    assert.equal(orderingTime(NOW, NOW - 1000, false, false, tol), NOW);
  });
  it("ignores a synced clock that is too far off for a live message", () => {
    assert.equal(orderingTime(NOW, NOW - 3_600_000, true, false, tol), NOW);
  });
  it("accepts an old device time for a replay", () => {
    assert.equal(orderingTime(NOW, NOW - 3_600_000, true, true, tol), NOW - 3_600_000);
  });
  it("never accepts a device time in the future", () => {
    assert.equal(orderingTime(NOW, NOW + 3_600_000, true, true, tol), NOW);
  });
  it("rejects a replay older than 30 days", () => {
    assert.equal(orderingTime(NOW, NOW - 40 * 86_400_000, true, true, tol), NOW);
  });
});

describe("toRow", () => {
  it("stores cells as millivolts and temperatures in 0.1 degC by channel", () => {
    const row = toRow(1, parseReading(payload(), "P", "t", NOW));
    assert.deepEqual(row.cells_mv, [3300, 3301, 3299, 3300]);
    assert.equal(row.cell_min_mv, 3299);
    assert.equal(row.cell_max_mv, 3301);
    assert.deepEqual(row.temps_dc, [292, null, 301]);
    assert.equal(row.temp_max_dc, 301);
  });

  it("packs alarms into a bitmask in ALARM_KEYS order", () => {
    const row = toRow(1, parseReading(payload(), "P", "t", NOW));
    // over_current=0, over_discharge=1, over_charge=2, over_temperature=3
    assert.equal(row.alarms, (1 << 1) | (1 << 3));
  });

  it("drops a device time that was never set", () => {
    const row = toRow(1, parseReading(payload({ unix_timestamp: 5 }), "P", "t", NOW));
    assert.equal(row.device_at, null);
  });
});

describe("Writer", () => {
  // Minimal stand-in for postgres.js: tx(rows, ...cols) builds a helper,
  // tx`...` runs a statement. Readings with voltage -1 are refused like a
  // value out of range (SQLSTATE 22003), failing the whole statement.
  function fakeSql() {
    const stored: { pack_id: number; voltage: number | null }[] = [];
    const tx = (first: unknown, ...rest: unknown[]) => {
      if (!(Array.isArray(first) && "raw" in first)) return { rows: first };
      if (!first[0].includes("insert into readings")) return { count: 0 };
      const rows = (rest[0] as { rows: { pack_id: number; voltage: number | null }[] }).rows;
      if (rows.some((r) => r.voltage === -1)) {
        throw Object.assign(new Error("value out of range"), { code: "22003" });
      }
      stored.push(...rows);
      return { count: rows.length };
    };
    const sql = { begin: async (fn: (t: typeof tx) => unknown) => fn(tx) };
    return { sql: sql as never, stored };
  }

  const reading = (voltage: number) => ({ ...parseReading(payload(), "P", "t", NOW), voltage });

  it("loses only the row the database refuses, not the rest of its batch", async () => {
    const { sql, stored } = fakeSql();
    const w = new Writer(sql, { intervalMs: 1000, maxRows: 100, bufferMax: 1000 });
    w.push(1, reading(13.2));
    w.push(2, reading(-1));
    w.push(3, reading(13.3));
    await w.flush();
    assert.deepEqual(stored.map((r) => r.pack_id), [1, 3]);
    assert.equal(w.stats.written, 2);
    assert.equal(w.stats.dropped, 1);
    assert.equal(w.stats.buffered, 0);
  });

  it("writes the whole batch in one statement when nothing is refused", async () => {
    const { sql, stored } = fakeSql();
    const w = new Writer(sql, { intervalMs: 1000, maxRows: 100, bufferMax: 1000 });
    w.push(1, reading(13.2));
    w.push(2, reading(13.3));
    await w.flush();
    assert.equal(stored.length, 2);
    assert.equal(w.stats.dropped, 0);
    assert.equal(w.stats.lastError, null);
  });
});
