/**
 * Alert rules: decides when something is worth a WhatsApp message.
 *
 * Pure state machine, no I/O, so it can be tested with fake clocks. The
 * notifier (notifier.ts) feeds it readings and a 5 s tick, and sends what
 * comes out.
 *
 * Every alert is a "condition" under a key (pack + what). A condition is
 * raised once it has been true for its debounce time, and cleared once it
 * has been false for its clear time. One message per raise, one per clear:
 * never one per reading.
 *
 *   alarm:<flag>   a BMS alarm flag from the payload (ALARM_KEYS)
 *   cell:silent    a cell inside the string reads 0 V (sense-lead fault)
 *   cell:spread    max - min cell voltage above the threshold
 *   offline        no reading from a pack for offlineMs
 *   system:mqtt    ingest has lost the MQTT broker
 *   system:db      the database refuses writes; readings pile up in memory
 */

import { ALARM_KEYS, type Alarms, type Reading } from "../lib/telemetry.ts";

export type AlertOptions = {
  /** A BMS flag must be set this long before it is raised. */
  alarmDebounceMs: number;
  /** Cell checks must fail this long (spread jumps under load, at top of charge). */
  cellDebounceMs: number;
  /** A raised condition must be false this long before it is cleared. */
  clearMs: number;
  /** No reading for this long = offline. */
  offlineMs: number;
  /** MQTT or database down this long = system alert. */
  systemDownMs: number;
  /** Raise cell:spread at this many mV; clear below 80 % of it. */
  spreadMv: number;
  /**
   * After a raise was sent, the same condition raised again within this time
   * is not sent (and neither is its clear). Stops a flapping flag spamming.
   */
  cooldownMs: number;
  /** device_ids that never alert (bench packs, packs being commissioned). */
  mutedPacks: string[];
};

export type AlertKind = "raised" | "cleared";

export type AlertEvent = {
  key: string;
  /** device_id, or null for system alerts. */
  pack: string | null;
  condition: string;
  kind: AlertKind;
  /** When it became true (raised) or how long it lasted (cleared). */
  since: number;
  at: number;
  /** False when the cooldown says not to send it. Still logged. */
  notify: boolean;
  /** One-line facts at the moment of the event. */
  detail: string;
};

/** What is restored from the database after a restart. */
export type ActiveRecord = { key: string; since: number; notified: boolean };

export type SystemHealth = {
  mqttConnected: boolean;
  mqttError: string | null;
  /** Writer's last error while readings are still buffered, else null. */
  dbError: string | null;
  buffered: number;
};

type State = {
  pack: string | null;
  condition: string;
  /** Current truth of the condition and when it last flipped. */
  truth: boolean;
  changedAt: number;
  detail: string;
  debounceMs: number;
  clearMs: number;
  active: boolean;
  since: number;
  notified: boolean;
};

export const ALARM_LABELS: Record<keyof Alarms, string> = {
  over_current: "Over-current",
  over_discharge: "Over-discharge (low voltage)",
  over_charge: "Over-charge (high voltage)",
  over_temperature: "Over-temperature",
  cell_string_error: "Cell string error",
};

export function conditionLabel(condition: string): string {
  if (condition.startsWith("alarm:")) {
    const k = condition.slice(6) as keyof Alarms;
    return ALARM_LABELS[k] ?? k;
  }
  switch (condition) {
    case "cell:silent":
      return "Cell reading 0 V";
    case "cell:spread":
      return "High cell imbalance";
    case "offline":
      return "Pack offline";
    case "system:mqtt":
      return "MQTT broker unreachable";
    case "system:db":
      return "Database unreachable";
    default:
      return condition;
  }
}

const fmt = (v: number | null, dp: number, unit: string) =>
  v === null ? null : `${v.toFixed(dp)}${unit}`;

/** Pack figures for a message: one line, short. */
export function readingSummary(r: Reading): string {
  const parts = [
    fmt(r.voltage, 1, " V"),
    fmt(r.current, 1, " A"),
    r.soc === null ? null : `SOC ${Math.round(r.soc)}%`,
  ];
  if (r.cellMin !== null && r.cellMax !== null) {
    parts.push(`cells ${r.cellMin.toFixed(3)}-${r.cellMax.toFixed(3)} V (${r.spreadMv} mV spread)`);
  }
  const temps = r.moduleTemps.map((t) => t.value);
  if (r.hostTemp !== null) temps.push(r.hostTemp);
  if (temps.length) parts.push(`max temp ${Math.max(...temps).toFixed(1)} C`);
  return parts.filter(Boolean).join(", ");
}

export class AlertEngine {
  private opts: AlertOptions;
  private states = new Map<string, State>();
  /** Last time a raise was sent, per key (cooldown). */
  private lastNotified = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private lastReading = new Map<string, Reading>();
  /** Keys restored as active from the database, not yet re-confirmed. */
  private restored = new Set<string>();
  private startedAt: number;

  constructor(opts: AlertOptions, now: number, restored: ActiveRecord[] = []) {
    this.opts = opts;
    this.startedAt = now;
    for (const a of restored) {
      const [pack, condition] = splitKey(a.key);
      this.states.set(a.key, {
        pack,
        condition,
        // Assume still true until a reading says otherwise.
        truth: true,
        changedAt: now,
        detail: "",
        debounceMs: 0,
        clearMs: this.clearFor(condition),
        active: true,
        since: a.since,
        notified: a.notified,
      });
      this.restored.add(a.key);
      if (a.notified) this.lastNotified.set(a.key, a.since);
    }
  }

  /** Raised conditions, for /status. */
  active(): { pack: string | null; condition: string; since: number; notified: boolean }[] {
    return [...this.states.values()]
      .filter((s) => s.active)
      .map((s) => ({ pack: s.pack, condition: s.condition, since: s.since, notified: s.notified }));
  }

  /** Feed one accepted reading. Returns events that are due right away. */
  observe(r: Reading, now: number): AlertEvent[] {
    const pack = r.packId;
    // A replayed reading is history from the device's offline buffer: it
    // proves the pack is back, but its alarms are not news any more.
    this.lastSeen.set(pack, now);
    this.restored.delete(keyOf(pack, "offline"));
    if (this.opts.mutedPacks.includes(pack)) return [];
    this.setTruth(pack, "offline", false, "", now);
    if (r.replay) return this.step(now);

    this.lastReading.set(pack, r);
    const summary = readingSummary(r);
    for (const k of ALARM_KEYS) {
      this.setTruth(pack, `alarm:${k}`, r.alarms[k], summary, now);
    }
    this.setTruth(
      pack,
      "cell:silent",
      r.silentCells.length > 0,
      r.silentCells.length ? `Cell ${r.silentCells.join(", ")} of ${r.seriesCount} read 0 V (sense lead?). ${summary}` : summary,
      now,
    );
    if (r.spreadMv !== null) {
      const spreadKey = keyOf(pack, "cell:spread");
      const raised = this.states.get(spreadKey)?.active ?? false;
      const limit = raised ? this.opts.spreadMv * 0.8 : this.opts.spreadMv;
      this.setTruth(pack, "cell:spread", r.spreadMv >= limit, `Spread ${r.spreadMv} mV (limit ${this.opts.spreadMv} mV). ${summary}`, now);
    }
    return this.step(now);
  }

  /**
   * Call every few seconds: checks for silent packs and system health, and
   * moves debounce and clear timers along.
   */
  tick(now: number, packs: string[], sys: SystemHealth): AlertEvent[] {
    // A pack that was disabled (or muted) drops its alerts without a message.
    for (const [key, s] of this.states) {
      if (s.pack !== null && (!packs.includes(s.pack) || this.opts.mutedPacks.includes(s.pack))) {
        this.states.delete(key);
        this.restored.delete(key);
      }
    }
    for (const pack of packs) {
      if (this.opts.mutedPacks.includes(pack)) continue;
      const key = keyOf(pack, "offline");
      const seen = this.lastSeen.get(pack);
      const silentFor = now - (seen ?? this.startedAt);
      // Restored "offline" stays raised until the pack actually sends.
      const offline = this.restored.has(key) || silentFor >= this.opts.offlineMs;
      const last = seen ?? this.startedAt;
      this.setTruth(pack, "offline", offline, seen === undefined ? `No data since ingest started at ${clock(last)}.` : `No data since ${clock(last)}.`, now);
    }
    this.setTruth(null, "system:mqtt", !sys.mqttConnected, sys.mqttError ? `Error: ${sys.mqttError}` : "Disconnected from the broker.", now);
    this.setTruth(
      null,
      "system:db",
      sys.dbError !== null,
      `${sys.buffered} readings waiting in memory. Error: ${sys.dbError ?? ""}`,
      now,
    );
    return this.step(now);
  }

  private debounceFor(condition: string): number {
    if (condition.startsWith("alarm:")) return this.opts.alarmDebounceMs;
    if (condition.startsWith("cell:")) return this.opts.cellDebounceMs;
    if (condition.startsWith("system:")) return this.opts.systemDownMs;
    return 0; // offline: the threshold already is the delay
  }

  private clearFor(condition: string): number {
    // Back online is news the moment data arrives.
    if (condition === "offline") return 0;
    if (condition.startsWith("cell:")) return Math.max(this.opts.clearMs, this.opts.cellDebounceMs);
    return this.opts.clearMs;
  }

  private setTruth(pack: string | null, condition: string, truth: boolean, detail: string, now: number) {
    const key = keyOf(pack, condition);
    let s = this.states.get(key);
    if (!s) {
      if (!truth) return; // nothing to track
      s = {
        pack,
        condition,
        truth: false,
        changedAt: now,
        detail,
        debounceMs: this.debounceFor(condition),
        clearMs: this.clearFor(condition),
        active: false,
        since: now,
        notified: false,
      };
      this.states.set(key, s);
    }
    if (s.truth !== truth) {
      s.truth = truth;
      s.changedAt = now;
    }
    if (truth || !s.active) s.detail = detail;
    else if (detail) s.detail = detail; // latest figures for the "cleared" message
  }

  private step(now: number): AlertEvent[] {
    const events: AlertEvent[] = [];
    for (const [key, s] of this.states) {
      if (!s.active && s.truth && now - s.changedAt >= s.debounceMs) {
        const last = this.lastNotified.get(key);
        const notify = last === undefined || now - last >= this.opts.cooldownMs;
        s.active = true;
        // Offline counts from the last reading, not from when we noticed.
        s.since = s.condition === "offline"
          ? (this.lastSeen.get(s.pack ?? "") ?? this.startedAt)
          : s.changedAt;
        s.notified = notify;
        if (notify) this.lastNotified.set(key, now);
        events.push(this.event(key, s, "raised", now, notify));
      } else if (s.active && !s.truth && now - s.changedAt >= s.clearMs) {
        s.active = false;
        this.restored.delete(key);
        events.push(this.event(key, s, "cleared", now, s.notified));
        this.states.delete(key);
      } else if (!s.active && !s.truth) {
        this.states.delete(key); // blipped true, never raised
      }
    }
    return events;
  }

  private event(key: string, s: State, kind: AlertKind, now: number, notify: boolean): AlertEvent {
    let detail = s.detail;
    if (kind === "cleared") {
      // Until it went false, not until the clear delay ran out.
      const lasted = `Lasted ${duration(s.changedAt - s.since)}.`;
      const r = s.pack ? this.lastReading.get(s.pack) : undefined;
      detail = s.condition === "offline"
        ? `Data resumed after ${duration(now - s.since)} offline.`
        : r && s.pack ? `${lasted} Now: ${readingSummary(r)}` : lasted;
    } else if (s.condition === "offline") {
      detail = `${s.detail} Silent for ${duration(now - (this.lastSeen.get(s.pack ?? "") ?? this.startedAt))}.`;
    }
    return { key, pack: s.pack, condition: s.condition, kind, since: s.since, at: now, notify, detail };
  }
}

export function keyOf(pack: string | null, condition: string) {
  return `${pack ?? "system"}|${condition}`;
}

function splitKey(key: string): [string | null, string] {
  const i = key.indexOf("|");
  const pack = key.slice(0, i);
  return [pack === "system" ? null : pack, key.slice(i + 1)];
}

/** "3 min", "2 h 5 min", "45 s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

let timeZone = "Asia/Kolkata";
export function setAlertTimeZone(tz: string) {
  timeZone = tz;
}

/** "14 Nov, 12:04" in the alert time zone. */
export function clock(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}
