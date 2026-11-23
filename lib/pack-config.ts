/**
 * Remotely settable pack configuration: the one definition of what may be
 * sent, and within what bounds.
 *
 * Shared by ingest (which validates before publishing) and the web app
 * (which builds the form from it), so the dashboard can never offer a value
 * the server would reject. The server validates regardless — the browser is
 * not trusted.
 *
 * Only keys the firmware supports today belong here. Anything else is
 * rejected rather than forwarded: a device that receives a key it does not
 * understand may ignore the whole message.
 */

export type ConfigKey = "can_baud_kbps" | "telemetry_interval_ms";

export type FieldSpec = {
  key: ConfigKey;
  label: string;
  unit: string;
  help: string;
  /** The device restarts after accepting this, so telemetry stops for a while. */
  restarts: boolean;
} & ({ kind: "enum"; values: number[] } | { kind: "range"; min: number; max: number; step: number });

export const CONFIG_FIELDS: FieldSpec[] = [
  {
    key: "can_baud_kbps",
    kind: "enum",
    values: [250, 500],
    label: "CAN bitrate",
    unit: "kbps",
    // The 192S BMS protocol document specifies 250 kHz and offers no bitrate
    // command, so 500 silences the BMS link on that hardware.
    help: "Must match the BMS. The 192S protocol runs at 250 kbps — 500 will stop the BMS being read.",
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
    restarts: false,
  },
];

export const FIELD_BY_KEY: Record<ConfigKey, FieldSpec> = Object.fromEntries(
  CONFIG_FIELDS.map((f) => [f.key, f]),
) as Record<ConfigKey, FieldSpec>;

export type ConfigSettings = Partial<Record<ConfigKey, number>>;

export type Validation =
  | { ok: true; settings: ConfigSettings; restarts: boolean }
  | { ok: false; errors: string[] };

/** True when this value is acceptable for the field. */
export function fieldError(f: FieldSpec, v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${f.label}: not a number`;
  if (f.kind === "enum") {
    return f.values.includes(v) ? null : `${f.label}: must be one of ${f.values.join(", ")} ${f.unit}`;
  }
  if (!Number.isInteger(v)) return `${f.label}: must be a whole number of ${f.unit}`;
  if (v < f.min || v > f.max) {
    return `${f.label}: must be ${f.min.toLocaleString("en-IN")}–${f.max.toLocaleString("en-IN")} ${f.unit}`;
  }
  return null;
}

/**
 * Checks a settings object from the dashboard. Unknown keys are an error
 * rather than being dropped, so a typo cannot silently send nothing.
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
    const err = fieldError(f, v);
    if (err) errors.push(err);
    else settings[f.key] = v as number;
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
  | "restarting"
  | "applied"
  | "rejected"
  | "timeout"
  | "failed";

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pending",
  sent: "Sent, waiting for the device",
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
