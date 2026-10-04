/**
 * Device payload -> Reading.
 *
 * The ESP32 publishes engineering units (volts, amps, degC). This turns one
 * message into a normalised Reading and derives the checks worth showing:
 * detected series count, cell spread, and whether the cells add up to the
 * pack voltage.
 */

export type Alarms = {
  over_current: boolean;
  over_discharge: boolean;
  over_charge: boolean;
  over_temperature: boolean;
  cell_string_error: boolean;
};

export type Reading = {
  packId: string;
  topic: string;
  /**
   * Ordering time, epoch ms: deviceTime when the device says its clock is
   * NTP-synced and it is plausible, otherwise receivedAt. See orderingTime().
   */
  ts: number;
  /** Server arrival time, epoch ms. */
  receivedAt: number;
  /** What the device claims, epoch ms. Trusted only via orderingTime(). */
  deviceTime: number | null;
  /** deviceTime - receivedAt, seconds. Large = device clock is wrong. */
  clockSkewS: number | null;
  /** Firmware says its clock is NTP-synced (`time_ok: true`). */
  timeOk: boolean;
  /** Sent from the device's offline buffer after a reconnect (`replay: true`). */
  replay: boolean;
  /** Per-boot message counter (`seq`), for spotting gaps and duplicates. */
  seq: number | null;
  status: string;
  schema: number;

  voltage: number | null;
  current: number | null;
  power: number | null;
  soc: number | null;
  remainingAh: number | null;
  hostTemp: number | null;

  /** Cells inside the detected string, index 0 = cell 1. */
  cells: number[];
  /** 1-based positions inside the string that read 0 V (sense-lead fault). */
  silentCells: number[];
  seriesCount: number;
  cellMin: number | null;
  cellMax: number | null;
  cellAvg: number | null;
  /** max - min, millivolts. */
  spreadMv: number | null;
  /** sum(cells) - pack voltage, volts. Near zero when scaling is right. */
  sumMismatchV: number | null;

  /** Channels that report something; absent sensors read 0 and are dropped. */
  moduleTemps: { index: number; value: number }[];

  alarms: Alarms;
  activeAlarms: string[];
};

export class PayloadError extends Error {}

const MAX_CELLS = 256;
const MAX_CELL_V = 10;
// A "replay" older than this is a broken clock, not a buffered reading.
const MAX_REPLAY_AGE_MS = 30 * 86_400_000;

export const ALARM_KEYS: (keyof Alarms)[] = [
  "over_current",
  "over_discharge",
  "over_charge",
  "over_temperature",
  "cell_string_error",
];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function deviceTimeMs(doc: Record<string, unknown>): number | null {
  const unix = num(doc.unix_timestamp);
  if (unix !== null) return unix * 1000;
  if (typeof doc.timestamp === "string") {
    const t = Date.parse(doc.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Which time a reading is filed under. Arrival time is safe but wrong for
 * readings replayed from the device's offline buffer; the device clock is
 * right for those but only once NTP works (the current firmware is hours
 * off). So: device time when the firmware says it is synced and it is not in
 * the future, and for live (non-replay) messages also close to arrival.
 */
export function orderingTime(
  receivedAt: number,
  deviceTime: number | null,
  timeOk: boolean,
  replay: boolean,
  toleranceS: number,
): number {
  if (!timeOk || deviceTime === null) return receivedAt;
  const skewMs = deviceTime - receivedAt;
  if (skewMs > toleranceS * 1000) return receivedAt;
  if (skewMs < -MAX_REPLAY_AGE_MS) return receivedAt;
  if (!replay && skewMs < -toleranceS * 1000) return receivedAt;
  return deviceTime;
}

export function parseReading(
  doc: unknown,
  packId: string,
  topic: string,
  receivedAt: number,
  clockToleranceS = 300,
): Reading {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new PayloadError("payload is not a JSON object");
  }
  const d = doc as Record<string, unknown>;
  const t = (d.telemetry ?? {}) as Record<string, unknown>;
  if (typeof t !== "object" || t === null) {
    throw new PayloadError("telemetry is missing");
  }

  // Cells: the device sends a fixed-size array padded with zeros. The string
  // ends at the last non-zero channel; a zero before that is a real fault.
  const rawCells = Array.isArray(t.cell_voltages_v)
    ? (t.cell_voltages_v as unknown[]).map((v) => num(v) ?? 0)
    : [];
  // Bounds keep one garbage payload from failing a whole database batch
  // (cells are stored as smallint millivolts).
  if (rawCells.length > MAX_CELLS) {
    throw new PayloadError(`${rawCells.length} cells, more than ${MAX_CELLS}`);
  }
  if (rawCells.some((v) => v < 0 || v > MAX_CELL_V)) {
    throw new PayloadError(`cell voltage outside 0–${MAX_CELL_V} V`);
  }
  let last = rawCells.length - 1;
  while (last >= 0 && rawCells[last] <= 0) last--;
  const cells = rawCells.slice(0, last + 1);
  const silentCells = cells
    .map((v, i) => (v <= 0 ? i + 1 : 0))
    .filter(Boolean);
  const live = cells.filter((v) => v > 0);

  const voltage = num(t.total_voltage_v);
  const current = num(t.total_current_a);

  let cellMin = null,
    cellMax = null,
    cellAvg = null,
    spreadMv = null,
    sumMismatchV = null;
  if (live.length) {
    cellMin = Math.min(...live);
    cellMax = Math.max(...live);
    cellAvg = round(live.reduce((a, b) => a + b, 0) / live.length, 4);
    spreadMv = Math.round((cellMax - cellMin) * 1000);
    if (voltage !== null && silentCells.length === 0) {
      sumMismatchV = round(cells.reduce((a, b) => a + b, 0) - voltage, 3);
    }
  }

  const moduleTemps = (Array.isArray(t.module_temps_c) ? t.module_temps_c : [])
    .map((v, i) => ({ index: i + 1, value: num(v) }))
    .filter(
      (m): m is { index: number; value: number } =>
        m.value !== null && m.value !== 0 && m.value > -60 && m.value < 300,
    );

  const a = (d.alarms ?? {}) as Record<string, unknown>;
  const alarms = Object.fromEntries(
    ALARM_KEYS.map((k) => [k, a[k] === true]),
  ) as Alarms;

  const deviceTime = deviceTimeMs(d);
  const hostTemp = num(t.host_temp_c);
  const timeOk = d.time_ok === true;
  const replay = d.replay === true;
  const seq = num(d.seq);

  return {
    packId,
    topic,
    ts: orderingTime(receivedAt, deviceTime, timeOk, replay, clockToleranceS),
    receivedAt,
    deviceTime,
    clockSkewS:
      deviceTime === null ? null : Math.round((deviceTime - receivedAt) / 1000),
    timeOk,
    replay,
    seq: seq !== null && Number.isInteger(seq) && Math.abs(seq) < 2 ** 31 ? seq : null,
    status: typeof d.system_status === "string" ? d.system_status : "UNKNOWN",
    schema: num(d.schema) ?? 1,
    voltage,
    current,
    power: voltage !== null && current !== null ? round(voltage * current, 1) : null,
    soc: num(t.soc_percent),
    remainingAh: num(t.remaining_capacity_ah) === null ? null : round(num(t.remaining_capacity_ah)!, 2),
    // 0 almost always means "sensor not fitted", not 0 degC.
    hostTemp: hostTemp === 0 ? null : hostTemp,
    cells,
    silentCells,
    seriesCount: cells.length,
    cellMin,
    cellMax,
    cellAvg,
    spreadMv,
    sumMismatchV,
    moduleTemps,
    alarms,
    activeAlarms: ALARM_KEYS.filter((k) => alarms[k]),
  };
}
