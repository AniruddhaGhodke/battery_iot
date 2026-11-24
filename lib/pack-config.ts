/**
 * Remotely settable pack configuration: the one definition of what may be
 * sent, and within what bounds.
 *
 * Shared by ingest (which validates before publishing) and the web app
 * (which builds the form from it), so the dashboard can never offer a value
 * the server would reject. The server validates regardless — the browser is
 * not trusted.
 *
 * Two kinds of setting live here:
 *
 *   target "gateway"  the ESP32's own behaviour, e.g. how often it publishes
 *   target "bms"      forwarded to the BMS over CAN (ids from the 192S
 *                     protocol's "Host data receiving part", CAN id 0xF4)
 *
 * A field marked `pending` is defined but cannot be sent: the gateway
 * firmware does not forward it yet. Sending a key the firmware does not know
 * risks it ignoring the whole message, so `validateSettings` refuses them and
 * the dashboard shows them as awaiting firmware. Clearing the flag once
 * firmware confirms a field is the only change needed to enable it.
 *
 * Values are engineering units — millivolts, amps, degrees. The raw CAN
 * encoding is the firmware's business, not the dashboard's, which keeps the
 * one thing the protocol document does not state (scaling) in the one place
 * that can verify it against the BMS's own broadcast.
 */

export type ConfigKey =
  // gateway
  | "device_id"
  | "can_baud_kbps"
  | "telemetry_interval_ms"
  // BMS protection setpoints
  | "bms_over_discharge_mv"
  | "bms_over_charge_mv"
  | "bms_over_current_a"
  | "bms_over_temperature_c"
  | "bms_low_temperature_c"
  | "bms_discharge_recovery_mv"
  | "bms_charge_recovery_mv"
  | "bms_cell_diff_mv"
  | "bms_power_off_mv"
  | "bms_power_off_delay_s"
  // balancing
  | "bms_auto_balance"
  | "bms_balance_start_mv"
  // thermal management
  | "bms_fan_start_c"
  | "bms_ptc_start_c"
  // commissioning
  | "bms_capacity_ah"
  | "bms_series_count"
  | "bms_hall_sensor"
  | "bms_precharge_delay_s"
  | "bms_power_on_default";

export type FieldGroup = "gateway" | "protection" | "balancing" | "thermal" | "commissioning";

export const GROUP_LABEL: Record<FieldGroup, string> = {
  gateway: "Gateway",
  protection: "Protection setpoints",
  balancing: "Balancing",
  thermal: "Thermal management",
  commissioning: "Commissioning",
};

export const GROUP_HELP: Record<FieldGroup, string> = {
  gateway: "The ESP32's own behaviour. Does not touch the BMS.",
  protection:
    "The pack's last line of defence. Raising a limit reduces protection, and the BMS alarm flags the alerts rely on are generated against these values.",
  balancing: "How the BMS equalises cells.",
  thermal: "Fan and heater thresholds.",
  commissioning:
    "Describes the pack itself. Wrong values make every reading wrong — normally set once at build and left alone.",
};

type Common = {
  key: ConfigKey;
  label: string;
  unit: string;
  help: string;
  group: FieldGroup;
  target: "gateway" | "bms";
  /** The device restarts after accepting this, so telemetry stops for a while. */
  restarts: boolean;
  /** CAN command id in the 192S protocol, for whoever writes the firmware. */
  canCommand?: string;
  /** Firmware does not forward this yet, so it cannot be sent. */
  pending?: boolean;
};

export type FieldSpec = Common &
  (
    | { kind: "enum"; values: number[] }
    | { kind: "range"; min: number; max: number; step: number }
    | { kind: "bool"; onValue: number; offValue: number }
    // A string setting. `pattern` and `maxLength` mirror the firmware's own
    // check, so the dashboard refuses what the device would refuse.
    | { kind: "text"; pattern: RegExp; maxLength: number; placeholder: string }
  );

export const CONFIG_FIELDS: FieldSpec[] = [
  // ---- gateway -----------------------------------------------------------
  {
    key: "device_id",
    kind: "text",
    // Mirrors isValidDeviceId in the firmware's configManager.cpp.
    pattern: /^[A-Za-z0-9_-]{1,31}$/,
    maxLength: 31,
    placeholder: "EM_PACK_40S_01",
    label: "Device name",
    unit: "",
    help: "The name this pack reports itself as. Identity is the hardware UID, not this, so renaming keeps all of its history and is how two boards sharing a name are told apart.",
    group: "gateway",
    target: "gateway",
    restarts: false,
  },
  {
    key: "can_baud_kbps",
    kind: "enum",
    // 250 only. The 192S protocol runs at 250 kHz and has no bitrate command,
    // so 500 would silence the BMS link; it is not offered. Kept as a field so
    // a pack can be put back to 250 if it is ever changed by other means.
    values: [250],
    label: "CAN bitrate",
    unit: "kbps",
    help: "Fixed at 250 to match the 192S BMS. Sending it again is harmless and puts a mis-set pack back.",
    group: "gateway",
    target: "gateway",
    restarts: true,
  },
  {
    key: "telemetry_interval_ms",
    kind: "range",
    min: 1_000,
    max: 300_000,
    step: 1_000,
    label: "Telemetry interval",
    unit: "ms",
    help: "How often the pack publishes. Longer intervals delay alerts by the same amount.",
    group: "gateway",
    target: "gateway",
    restarts: false,
  },

  // ---- BMS protection setpoints -------------------------------------------
  {
    key: "bms_over_discharge_mv",
    kind: "range",
    min: 2_000,
    max: 3_000,
    step: 10,
    label: "Over-discharge cut-off",
    unit: "mV/cell",
    help: "Per cell. Below about 2,500 mV an LFP cell is into the knee with almost nothing left.",
    group: "protection",
    target: "bms",
    canCommand: "0x01",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_over_charge_mv",
    kind: "range",
    min: 3_400,
    max: 3_800,
    step: 10,
    label: "Over-charge cut-off",
    unit: "mV/cell",
    help: "Per cell. 3,650 mV is the usual LFP ceiling; above that costs cycle life quickly.",
    group: "protection",
    target: "bms",
    canCommand: "0x05",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_over_current_a",
    kind: "range",
    min: 1,
    max: 1_000,
    step: 1,
    label: "Over-current limit",
    unit: "A",
    help: "Must sit below the contactor, fuse and cable rating, not just the cells'.",
    group: "protection",
    target: "bms",
    canCommand: "0x02",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_over_temperature_c",
    kind: "range",
    min: 0,
    max: 100,
    step: 1,
    label: "Over-temperature limit",
    unit: "°C",
    help: "Raising this silences the over-temperature alert as well as the protection.",
    group: "protection",
    target: "bms",
    canCommand: "0x06",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_low_temperature_c",
    kind: "range",
    min: -100,
    max: 0,
    step: 1,
    label: "Low-temperature limit",
    unit: "°C",
    help: "Charging LFP below 0 °C plates lithium. The protocol allows −100 to 0.",
    group: "protection",
    target: "bms",
    canCommand: "0x18",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_discharge_recovery_mv",
    kind: "range",
    min: 2_000,
    max: 3_300,
    step: 10,
    label: "Discharge recovery",
    unit: "mV/cell",
    help: "Where discharge protection releases. Set it above the cut-off or the pack will chatter.",
    group: "protection",
    target: "bms",
    canCommand: "0x0B",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_charge_recovery_mv",
    kind: "range",
    min: 3_200,
    max: 3_700,
    step: 10,
    label: "Charge recovery",
    unit: "mV/cell",
    help: "Where charge protection releases. Set it below the cut-off.",
    group: "protection",
    target: "bms",
    canCommand: "0x0A",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_cell_diff_mv",
    kind: "range",
    min: 0,
    max: 5_000,
    step: 10,
    label: "Cell difference limit",
    unit: "mV",
    help: "The BMS's own imbalance protection. The dashboard's imbalance alert is separate and stays at ALERT_SPREAD_MV.",
    group: "protection",
    target: "bms",
    canCommand: "0x17",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_power_off_mv",
    kind: "range",
    min: 2_000,
    max: 3_300,
    step: 10,
    label: "Host power-off voltage",
    unit: "mV/cell",
    help: "Where the BMS shuts its own electronics down to stop draining the pack.",
    group: "protection",
    target: "bms",
    canCommand: "0x0E",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_power_off_delay_s",
    kind: "range",
    min: 0,
    max: 3_600,
    step: 1,
    label: "Power-off delay",
    unit: "s",
    help: "How long the low-voltage condition must hold before the BMS shuts down.",
    group: "protection",
    target: "bms",
    canCommand: "0x0F",
    restarts: false,
    pending: true,
  },

  // ---- balancing ----------------------------------------------------------
  {
    key: "bms_auto_balance",
    kind: "bool",
    // Note the inversion: 0x08 uses 0x0002 for on and 0x0001 for off, the
    // opposite of every other on/off command in the protocol.
    onValue: 2,
    offValue: 1,
    label: "Automatic balancing",
    unit: "",
    help: "Turning this off lets imbalance grow — the dashboard will keep reporting the spread, but nothing will act on it.",
    group: "balancing",
    target: "bms",
    canCommand: "0x08",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_balance_start_mv",
    kind: "range",
    min: 3_000,
    max: 3_700,
    step: 10,
    label: "Balance start voltage",
    unit: "mV/cell",
    help: "Balancing only runs above this while charging.",
    group: "balancing",
    target: "bms",
    canCommand: "0x11",
    restarts: false,
    pending: true,
  },

  // ---- thermal ------------------------------------------------------------
  {
    key: "bms_fan_start_c",
    kind: "range",
    min: 0,
    max: 100,
    step: 1,
    label: "Fan start",
    unit: "°C",
    help: "Set it well below the over-temperature limit so cooling has a chance to work.",
    group: "thermal",
    target: "bms",
    canCommand: "0x1A",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_ptc_start_c",
    kind: "range",
    min: 0,
    max: 100,
    step: 1,
    label: "Heater start",
    unit: "°C",
    help: "Where the PTC heater comes on. Should sit above the low-temperature limit.",
    group: "thermal",
    target: "bms",
    canCommand: "0x1B",
    restarts: false,
    pending: true,
  },

  // ---- commissioning ------------------------------------------------------
  {
    key: "bms_capacity_ah",
    kind: "range",
    min: 1,
    max: 10_000,
    step: 1,
    label: "Pack capacity",
    unit: "Ah",
    help: "Changing this rescales SOC and every stored capacity figure.",
    group: "commissioning",
    target: "bms",
    canCommand: "0x03",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_series_count",
    kind: "range",
    min: 1,
    max: 192,
    step: 1,
    label: "Cells in series",
    unit: "cells",
    help: "Must match the hardware. A wrong value breaks every per-cell reading and the protection with it.",
    group: "commissioning",
    target: "bms",
    canCommand: "0x04",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_hall_sensor",
    kind: "enum",
    values: [1, 2, 3],
    label: "Hall sensor type",
    unit: "",
    help: "Must match the fitted current sensor; the protocol's default is 2. A wrong type makes every current reading wrong.",
    group: "commissioning",
    target: "bms",
    canCommand: "0x19",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_power_on_default",
    kind: "bool",
    onValue: 1,
    offValue: 2,
    label: "Channel state after power-on",
    unit: "",
    help: "What the channel does when the BMS powers up. Decide this together with channel control: switching the channel off remotely means nothing if a power cycle closes it again.",
    group: "commissioning",
    target: "bms",
    canCommand: "0x0C",
    restarts: false,
    pending: true,
  },
  {
    key: "bms_precharge_delay_s",
    kind: "range",
    min: 0,
    max: 600,
    step: 1,
    label: "Pre-charge delay",
    unit: "s",
    help: "How long pre-charge runs before the main contactor closes.",
    group: "commissioning",
    target: "bms",
    canCommand: "0x16",
    restarts: false,
    pending: true,
  },
];

export const FIELD_BY_KEY: Record<ConfigKey, FieldSpec> = Object.fromEntries(
  CONFIG_FIELDS.map((f) => [f.key, f]),
) as Record<ConfigKey, FieldSpec>;

/** Fields that can actually be sent today. */
export function sendableFields(): FieldSpec[] {
  return CONFIG_FIELDS.filter((f) => !f.pending);
}

export const FIELD_GROUPS: FieldGroup[] = ["gateway", "protection", "balancing", "thermal", "commissioning"];

/** Settings are numbers in engineering units, or text for a name. */
export type ConfigValue = number | string;

export type ConfigSettings = Partial<Record<ConfigKey, ConfigValue>>;

export type Validation =
  | { ok: true; settings: ConfigSettings; restarts: boolean }
  | { ok: false; errors: string[] };

/** Null when this value is acceptable for the field, otherwise why not. */
export function fieldError(f: FieldSpec, v: unknown): string | null {
  if (f.kind === "text") {
    if (typeof v !== "string") return `${f.label}: must be text`;
    const s = v.trim();
    if (!s) return `${f.label}: cannot be empty`;
    if (s.length > f.maxLength) return `${f.label}: at most ${f.maxLength} characters`;
    return f.pattern.test(s) ? null : `${f.label}: letters, digits, _ and - only`;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return `${f.label}: not a number`;
  if (f.kind === "enum") {
    return f.values.includes(v)
      ? null
      : `${f.label}: must be ${f.values.join(" or ")}${f.unit ? ` ${f.unit}` : ""}`;
  }
  if (f.kind === "bool") {
    return v === f.onValue || v === f.offValue ? null : `${f.label}: must be on or off`;
  }
  if (!Number.isInteger(v)) return `${f.label}: must be a whole number of ${f.unit}`;
  if (v < f.min || v > f.max) {
    return `${f.label}: must be ${f.min.toLocaleString("en-IN")}–${f.max.toLocaleString("en-IN")} ${f.unit}`;
  }
  return null;
}

/**
 * Checks a settings object from the dashboard. Unknown keys are an error
 * rather than being dropped, so a typo cannot silently send nothing, and
 * fields the firmware does not support yet are refused outright.
 */
export function validateSettings(input: unknown): Validation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["settings must be a JSON object"] };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) return { ok: false, errors: ["no settings to send"] };

  const errors: string[] = [];
  const settings: ConfigSettings = {};
  for (const [k, v] of entries) {
    const f = FIELD_BY_KEY[k as ConfigKey];
    if (!f) {
      errors.push(`${k}: not a setting this firmware supports`);
      continue;
    }
    if (f.pending) {
      errors.push(`${f.label}: the gateway firmware does not forward this yet`);
      continue;
    }
    const err = fieldError(f, v);
    if (err) errors.push(err);
    else settings[f.key] = f.kind === "text" ? (v as string).trim() : (v as number);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    settings,
    restarts: Object.keys(settings).some((k) => FIELD_BY_KEY[k as ConfigKey].restarts),
  };
}

/** How long a pack may be silent after a restart before we call it offline. */
export const RESTART_GRACE_MS = 120_000;

/**
 * Staleness threshold for a pack publishing at this interval. The global
 * default suits the 5 s interval; a longer one must not read as offline.
 */
export function staleAfterMs(intervalMs: number | null, defaultMs: number): number {
  if (!intervalMs) return defaultMs;
  return Math.max(defaultMs, intervalMs * 3);
}

export type RequestStatus =
  | "pending"
  | "sent"
  // OTA only: the device is pulling the image over HTTPS.
  | "downloading"
  | "restarting"
  | "applied"
  | "rejected"
  | "timeout"
  | "failed";

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pending",
  sent: "Sent, waiting for the device",
  downloading: "Downloading the image",
  restarting: "Reconnecting — waiting for the device",
  applied: "Applied",
  rejected: "Rejected by the device",
  timeout: "No response",
  failed: "Could not send",
};

/** Statuses that will not change again. */
export function isFinal(s: RequestStatus): boolean {
  return s === "applied" || s === "rejected" || s === "timeout" || s === "failed";
}
