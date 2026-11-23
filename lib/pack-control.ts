/**
 * Control actions: switching the pack's channel, as opposed to configuring it.
 *
 * Kept apart from lib/pack-config.ts on purpose. A setpoint changes how the
 * BMS behaves; this opens or closes the path the current flows through, which
 * is a different safety class and gets different handling:
 *
 *   - its own MQTT topic and its own ACL entry, so "may configure" and "may
 *     switch the contactor" are separate permissions
 *   - an expiry in the payload, because the broker keeps queued messages for
 *     an offline device (persistence is on, 14-day session expiry) and a
 *     contactor command arriving hours late is dangerous rather than merely
 *     surprising; the firmware must drop a command past its expiry
 *   - an interlock checked against live telemetry before anything is sent
 *   - a confirmation step in the dashboard
 *
 * The 192S protocol has ONE channel command (0x07), not separate charge and
 * discharge control, even though it reports the two MOS states separately in
 * group 81 and logs "damaged charging relay" and "damaged discharge relay" as
 * distinct faults. Separate control would need the BMS vendor to confirm an
 * undocumented command or another bus.
 */

export type ControlAction = "channel";
export type ControlValue = "on" | "off";

export type ControlSpec = {
  action: ControlAction;
  label: string;
  help: string;
  /** Command id in the 192S protocol's host-receiving table. */
  canCommand: string;
  /** Raw values the firmware writes. 0x07 uses 1 for on and 2 for off. */
  onValue: number;
  offValue: number;
  /** Firmware does not forward this yet, so it cannot be sent. */
  pending: boolean;
};

export const CONTROL_ACTIONS: ControlSpec[] = [
  {
    action: "channel",
    label: "Charge / discharge channel",
    help:
      "Opens or closes the pack's channel. The protocol has one command for both directions — it cannot switch charge and discharge separately.",
    canCommand: "0x07",
    onValue: 1,
    offValue: 2,
    pending: true,
  },
];

export const CONTROL_BY_ACTION: Record<ControlAction, ControlSpec> = Object.fromEntries(
  CONTROL_ACTIONS.map((c) => [c.action, c]),
) as Record<ControlAction, ControlSpec>;

/** A command older than this must be ignored by the firmware. */
export const CONTROL_EXPIRY_MS = 60_000;

/** Opening the channel above this current risks arcing the contactor. */
export const CONTROL_MAX_CURRENT_A = 5;

/** Without a reading this recent we do not know what the pack is doing. */
export const CONTROL_MAX_READING_AGE_MS = 120_000;

/** The pack's last reading, for the interlock. */
export type LatestReading = { currentA: number | null; ageMs: number };

/**
 * Why this command must not be sent, or null if it may be.
 *
 * Opening a contactor while current flows draws an arc that pits and can weld
 * the contacts, so the switch is refused under load. Closing is allowed: a
 * channel that is open is not carrying anything, so a high reading means it is
 * already closed.
 */
export function interlockError(
  value: ControlValue,
  latest: LatestReading | null,
  maxCurrentA = CONTROL_MAX_CURRENT_A,
  maxAgeMs = CONTROL_MAX_READING_AGE_MS,
): string | null {
  if (!latest) {
    return "no telemetry from this pack, so its state is unknown — not switching blind";
  }
  if (latest.ageMs > maxAgeMs) {
    return `the last reading is ${Math.round(latest.ageMs / 1000)} s old, so the pack's state is unknown — not switching blind`;
  }
  if (value === "off") {
    if (latest.currentA === null) {
      return "the pack is not reporting current, so load cannot be checked before opening the channel";
    }
    if (Math.abs(latest.currentA) > maxCurrentA) {
      return `the pack is carrying ${Math.abs(latest.currentA).toFixed(1)} A — opening the channel under load can arc and weld the contactor. Stop the load first.`;
    }
  }
  return null;
}

export type ControlValidation =
  | { ok: true; spec: ControlSpec; value: ControlValue; raw: number }
  | { ok: false; error: string };

export function validateControl(action: unknown, value: unknown): ControlValidation {
  const spec = typeof action === "string" ? CONTROL_BY_ACTION[action as ControlAction] : undefined;
  if (!spec) return { ok: false, error: `unknown control action: ${String(action)}` };
  if (spec.pending) {
    return { ok: false, error: `${spec.label}: the gateway firmware does not forward this yet` };
  }
  if (value !== "on" && value !== "off") {
    return { ok: false, error: `${spec.label}: value must be "on" or "off"` };
  }
  return { ok: true, spec, value, raw: value === "on" ? spec.onValue : spec.offValue };
}
