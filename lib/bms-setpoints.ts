/**
 * The limits the BMS says it is running, as raw 16-bit counts.
 *
 * The BMS broadcasts its own configuration in sending groups 1, 2, 5 and 6,
 * and the gateway forwards those numbers untouched. They are deliberately not
 * converted to engineering units here, because nothing we have says what the
 * units are:
 *
 *   - The protocol document (V9.8, page 19) lists all 28 host commands and
 *     gives units for exactly three of them.
 *   - Where it does describe a range it is plausible but not decisive:
 *     "differential pressure setting value 0-5V" against a 16-bit field
 *     suggests millivolts, and nothing states whether a current limit is
 *     amps or tenths of an amp.
 *   - The document and the working firmware already disagree: group 4 byte
 *     4-5 is "battery capacity percentage" in the document and is decoded as
 *     remaining capacity in amp-hours by the firmware, and group 5's
 *     "remaining capacity" is decoded as state of charge.
 *
 * A protection limit written ten times too high is not a cosmetic bug — it
 * is the over-current trip that no longer trips. So these are displayed as
 * raw counts beside the value a human can read off the BMS's own screen, and
 * the scale for each field is fixed from that comparison before any write
 * path is enabled.
 */

/** What the gateway can report, keyed as it sends them. */
export const REPORTED_KEYS = [
  "over_discharge",
  "over_current",
  "pack_capacity",
  "series_count",
  "over_charge",
  "over_temperature",
  "charge_recovery",
  "discharge_recovery",
  "balance_start",
] as const;

export type ReportedKey = (typeof REPORTED_KEYS)[number];

export type ReportedSetpoints = Partial<Record<ReportedKey, number>>;

/** Which dashboard field each reported value belongs to. */
export const REPORTED_FOR_FIELD: Record<string, ReportedKey> = {
  bms_over_discharge_v: "over_discharge",
  bms_over_current_a: "over_current",
  bms_capacity_ah: "pack_capacity",
  bms_series_count: "series_count",
  bms_over_charge_v: "over_charge",
  bms_over_temperature_c: "over_temperature",
  bms_charge_recovery_v: "charge_recovery",
  bms_discharge_recovery_v: "discharge_recovery",
  bms_balance_start_v: "balance_start",
};

/**
 * Reads the `bms_setpoints_raw` object out of a telemetry payload. Returns
 * null when the pack sends none — firmware before this change does not, and
 * an absent group must not read as a limit of zero.
 */
export function parseReportedSetpoints(v: unknown): ReportedSetpoints | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const out: ReportedSetpoints = {};
  for (const k of REPORTED_KEYS) {
    const n = d[k];
    // 16-bit counts off the wire; anything else is not from this protocol.
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65_535) {
      out[k] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** True when two readings of the setpoints differ. */
export function setpointsDiffer(a: ReportedSetpoints | null, b: ReportedSetpoints | null): boolean {
  if (a === null || b === null) return a !== b;
  return REPORTED_KEYS.some((k) => a[k] !== b[k]);
}
