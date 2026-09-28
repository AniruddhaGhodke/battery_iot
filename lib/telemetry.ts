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
  /** Server arrival time, epoch ms. Used for everything time-related. */
  receivedAt: number;
  /** What the device claims, epoch ms. Shown, never trusted for ordering. */
  deviceTime: number | null;
  /** deviceTime - receivedAt, seconds. Large = device clock is wrong. */
  clockSkewS: number | null;
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

const ALARM_KEYS: (keyof Alarms)[] = [
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

export function parseReading(
  doc: unknown,
  packId: string,
  topic: string,
  receivedAt: number,
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
    .filter((m): m is { index: number; value: number } => m.value !== null && m.value !== 0);

  const a = (d.alarms ?? {}) as Record<string, unknown>;
  const alarms = Object.fromEntries(
    ALARM_KEYS.map((k) => [k, a[k] === true]),
  ) as Alarms;

  const deviceTime = deviceTimeMs(d);
  const hostTemp = num(t.host_temp_c);

  return {
    packId,
    topic,
    receivedAt,
    deviceTime,
    clockSkewS:
      deviceTime === null ? null : Math.round((deviceTime - receivedAt) / 1000),
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
