import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertEngine, type AlertOptions, duration, type SystemHealth } from "../ingest/alerts.ts";
import { Notifier, toMessages } from "../ingest/notifier.ts";
import { cleanParam, normalizeNumber, templateBody, WhatsAppError, WhatsAppSender } from "../ingest/whatsapp.ts";
import { parseReading } from "../lib/telemetry.ts";

const T0 = Date.UTC(2026, 10, 14, 6, 30, 0);
const S = 1000;
const MIN = 60 * S;

const OPTS: AlertOptions = {
  alarmDebounceMs: 10 * S,
  cellDebounceMs: 120 * S,
  clearMs: 60 * S,
  offlineMs: 10 * MIN,
  systemDownMs: 3 * MIN,
  spreadMv: 100,
  cooldownMs: 15 * MIN,
  mutedPacks: [],
};
const OK: SystemHealth = { mqttConnected: true, mqttError: null, dbError: null, buffered: 0 };

type Opts = { alarms?: Record<string, boolean>; cells?: number[]; replay?: boolean; pack?: string };
function reading(at: number, o: Opts = {}) {
  return parseReading(
    {
      device_id: o.pack ?? "P1",
      schema: 2,
      replay: o.replay,
      telemetry: {
        total_voltage_v: 13.2,
        total_current_a: -2.5,
        soc_percent: 80,
        cell_voltages_v: o.cells ?? [3.3, 3.3, 3.3, 3.3],
        module_temps_c: [30],
      },
      alarms: { over_current: false, over_discharge: false, over_charge: false, over_temperature: false, cell_string_error: false, ...o.alarms },
    },
    o.pack ?? "P1",
    "t",
    at,
  );
}

/** Feeds a reading every 5 s from `from` to `to`, ticking too; returns all events. */
function run(e: AlertEngine, from: number, to: number, o: Opts = {}) {
  const out = [];
  for (let t = from; t < to; t += 5 * S) {
    out.push(...e.observe(reading(t, o), t));
    out.push(...e.tick(t, [o.pack ?? "P1"], OK));
  }
  return out;
}

describe("AlertEngine", () => {
  it("raises a BMS alarm once after the debounce, and clears it once", () => {
    const e = new AlertEngine(OPTS, T0);
    const on = run(e, T0, T0 + 2 * MIN, { alarms: { over_temperature: true } });
    assert.equal(on.length, 1);
    assert.equal(on[0].kind, "raised");
    assert.equal(on[0].condition, "alarm:over_temperature");
    assert.equal(on[0].at - on[0].since, 10 * S);
    assert.match(on[0].detail, /13\.2 V/);
    assert.deepEqual(e.active().map((a) => a.condition), ["alarm:over_temperature"]);

    const off = run(e, T0 + 2 * MIN, T0 + 5 * MIN);
    assert.equal(off.length, 1);
    assert.equal(off[0].kind, "cleared");
    assert.match(off[0].detail, /Lasted 2 min/);
    assert.deepEqual(e.active(), []);
  });

  it("ignores a flag that flickers for less than the debounce", () => {
    const e = new AlertEngine(OPTS, T0);
    const ev = [
      ...run(e, T0, T0 + 5 * S, { alarms: { over_current: true } }),
      ...run(e, T0 + 5 * S, T0 + MIN),
    ];
    assert.deepEqual(ev, []);
  });

  it("does not resend a flapping alarm within the cooldown", () => {
    const e = new AlertEngine(OPTS, T0);
    let t = T0;
    const ev = [];
    for (let i = 0; i < 3; i++) {
      ev.push(...run(e, t, t + MIN, { alarms: { over_charge: true } }));
      ev.push(...run(e, t + MIN, t + 3 * MIN));
      t += 3 * MIN;
    }
    const raised = ev.filter((x) => x.kind === "raised");
    assert.equal(raised.length, 3);
    assert.deepEqual(raised.map((x) => x.notify), [true, false, false]);
    assert.deepEqual(ev.filter((x) => x.kind === "cleared").map((x) => x.notify), [true, false, false]);
  });

  it("ignores alarms in replayed readings", () => {
    const e = new AlertEngine(OPTS, T0);
    assert.deepEqual(run(e, T0, T0 + 2 * MIN, { alarms: { over_current: true }, replay: true }), []);
  });

  it("raises offline after the threshold and back online on the next reading", () => {
    const e = new AlertEngine(OPTS, T0);
    run(e, T0, T0 + MIN);
    const last = T0 + MIN - 5 * S;
    let ev = [];
    for (let t = T0 + MIN; t < T0 + 30 * MIN; t += 5 * S) ev.push(...e.tick(t, ["P1"], OK));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].condition, "offline");
    assert.equal(ev[0].since, last);
    ev = e.observe(reading(T0 + 30 * MIN), T0 + 30 * MIN);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, "cleared");
    assert.match(ev[0].detail, /resumed after 29 min/);
  });

  it("counts a pack that never sends since startup as offline", () => {
    const e = new AlertEngine(OPTS, T0);
    assert.equal(e.tick(T0 + 9 * MIN, ["P1"], OK).length, 0);
    const ev = e.tick(T0 + 10 * MIN, ["P1"], OK);
    assert.equal(ev.length, 1);
    assert.match(ev[0].detail, /since ingest started/);
  });

  it("raises cell imbalance only when it lasts, with hysteresis on clearing", () => {
    const e = new AlertEngine(OPTS, T0);
    const wide = [3.3, 3.3, 3.42, 3.3]; // 120 mV
    const ev = run(e, T0, T0 + 3 * MIN, { cells: wide });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].condition, "cell:spread");
    // 90 mV is above 80 % of the limit: stays raised.
    assert.deepEqual(run(e, T0 + 3 * MIN, T0 + 10 * MIN, { cells: [3.3, 3.3, 3.39, 3.3] }), []);
    const off = run(e, T0 + 10 * MIN, T0 + 15 * MIN, { cells: [3.3, 3.3, 3.32, 3.3] });
    assert.equal(off.length, 1);
    assert.equal(off[0].kind, "cleared");
  });

  it("raises a silent cell with its position", () => {
    const e = new AlertEngine(OPTS, T0);
    const ev = run(e, T0, T0 + 3 * MIN, { cells: [3.3, 0, 3.3, 3.3] });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].condition, "cell:silent");
    assert.match(ev[0].detail, /Cell 2 of 4 read 0 V/);
  });

  it("raises MQTT down after systemDownMs", () => {
    const e = new AlertEngine(OPTS, T0);
    const down = { ...OK, mqttConnected: false, mqttError: "ECONNREFUSED" };
    assert.deepEqual(e.tick(T0, [], down), []);
    assert.deepEqual(e.tick(T0 + 2 * MIN, [], down), []);
    const ev = e.tick(T0 + 3 * MIN, [], down);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].pack, null);
    assert.equal(ev[0].condition, "system:mqtt");
    assert.match(ev[0].detail, /ECONNREFUSED/);
  });

  it("restores raised alerts: no repeat, and the clear still comes", () => {
    const restored = [
      { key: "P1|alarm:over_temperature", since: T0 - 30 * MIN, notified: true },
      { key: "P1|offline", since: T0 - 60 * MIN, notified: true },
    ];
    const e = new AlertEngine(OPTS, T0, restored);
    // Pack still silent after restart: offline stays raised, nothing sent.
    assert.deepEqual(e.tick(T0 + 11 * MIN, ["P1"], OK), []);
    // Pack returns without the alarm: back online now, alarm cleared after clearMs.
    const ev = run(e, T0 + 12 * MIN, T0 + 14 * MIN);
    assert.deepEqual(ev.map((x) => `${x.condition}:${x.kind}`), ["offline:cleared", "alarm:over_temperature:cleared"]);
  });

  it("mutes listed packs", () => {
    const e = new AlertEngine({ ...OPTS, mutedPacks: ["P1"] }, T0);
    assert.deepEqual(run(e, T0, T0 + 2 * MIN, { alarms: { over_current: true } }), []);
    assert.deepEqual(e.tick(T0 + 20 * MIN, ["P1"], OK), []);
  });

  it("drops alerts of a pack that is no longer enabled, silently", () => {
    const e = new AlertEngine(OPTS, T0);
    run(e, T0, T0 + MIN, { alarms: { over_current: true } });
    assert.equal(e.active().length, 1);
    assert.deepEqual(e.tick(T0 + 2 * MIN, [], OK), []);
    assert.equal(e.active().length, 0);
  });
});

describe("toMessages", () => {
  it("groups simultaneous alarms of one pack into one message", () => {
    const e = new AlertEngine(OPTS, T0);
    const ev = run(e, T0, T0 + MIN, { alarms: { over_charge: true, over_temperature: true } });
    const msgs = toMessages(ev, "IST");
    assert.equal(msgs.length, 1);
    const [headline, pack, details, time] = msgs[0].params;
    assert.equal(headline, "🔴 2 alerts: Over-charge (high voltage), Over-temperature");
    assert.equal(pack, "P1");
    assert.match(details, /SOC 80%/);
    assert.match(time, /IST$/);
  });
});

describe("WhatsApp", () => {
  const cfg = { token: "tok", phoneNumberId: "123", template: "battery_alert", language: "en", apiVersion: "v26.0" };

  it("builds a template message with clean variables", () => {
    const b = templateBody(cfg, "+91 98765-43210", ["a\nb", "x     y", ""]);
    assert.equal(b.to, "919876543210");
    assert.equal(b.template.name, "battery_alert");
    assert.deepEqual(b.template.components[0].parameters.map((p) => p.text), ["a b", "x y", "-"]);
    assert.equal(cleanParam("x".repeat(500)).length, 400);
    assert.equal(normalizeNumber("+1 (555) 010-9999"), "15550109999");
  });

  it("returns the message id, and explains Meta errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new WhatsAppSender(cfg, (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch);
    assert.equal(await ok.send("919876543210", ["a", "b", "c", "d"]), "wamid.1");
    assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/123/messages");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");

    const bad = new WhatsAppSender(cfg, (async () =>
      new Response(JSON.stringify({ error: { code: 132001, message: "Template name does not exist" } }), { status: 404 })) as unknown as typeof fetch);
    await assert.rejects(bad.send("1", []), (e: WhatsAppError) => !e.retryable && /template not found/.test(e.message));

    const busy = new WhatsAppSender(cfg, (async () => new Response("oops", { status: 503 })) as unknown as typeof fetch);
    await assert.rejects(busy.send("1", []), (e: WhatsAppError) => e.retryable);
  });
});

describe("duration", () => {
  it("reads naturally", () => {
    assert.equal(duration(45 * S), "45 s");
    assert.equal(duration(12 * MIN), "12 min");
    assert.equal(duration(125 * MIN), "2 h 5 min");
    assert.equal(duration(72 * 60 * MIN), "3 days");
  });
});

describe("Notifier", () => {
  function fakeSql() {
    const queries: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql: any = (strings: unknown, ..._vals: unknown[]) => {
      if (!Array.isArray(strings) || !("raw" in strings)) return { helper: strings };
      queries.push((strings as string[]).join("?").replace(/\s+/g, " ").trim());
      return Promise.resolve([]);
    };
    sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql);
    return { sql, queries };
  }

  const base = {
    ...OPTS,
    enabled: true,
    recipients: ["+91 90000 00001", "+91 90000 00002"],
    whatsapp: { token: "t", phoneNumberId: "1", template: "battery_alert", language: "en", apiVersion: "v26.0" },
    timeZone: "Asia/Kolkata",
    timeZoneLabel: "IST",
    maxPerHour: 60,
  };

  it("sends one message per recipient, logs it and saves the active set", async () => {
    const { sql, queries } = fakeSql();
    const sent: { to: string; params: string[] }[] = [];
    const sender = { send: async (to: string, params: string[]) => (sent.push({ to, params }), "id") };
    const n = new Notifier(sql, base, sender as unknown as WhatsAppSender);
    await n.start(T0);
    for (let t = T0; t < T0 + MIN; t += 5 * S) {
      n.observe(reading(t, { alarms: { over_current: true } }), t);
      n.tick(["P1"], OK, t);
    }
    await n.idle();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((s) => s.to), base.recipients);
    assert.equal(sent[0].params[0], "🔴 Over-current");
    assert.equal(n.stats.sent, 1);
    assert.ok(queries.some((q) => q.startsWith("insert into alert_log")));
    assert.ok(queries.some((q) => q.startsWith("insert into alert_active")));
    assert.equal(n.active().length, 1);
  });

  it("logs but does not send when alerts are off", async () => {
    const { sql } = fakeSql();
    let calls = 0;
    const sender = { send: async () => (calls++, "id") };
    const n = new Notifier(sql, { ...base, enabled: false }, sender as unknown as WhatsAppSender);
    await n.start(T0);
    for (let t = T0; t < T0 + MIN; t += 5 * S) n.observe(reading(t, { alarms: { over_current: true } }), t);
    await n.idle();
    assert.equal(calls, 0);
    assert.equal(n.stats.suppressed, 1);
  });

  it("counts a failed send without throwing", async () => {
    const { sql } = fakeSql();
    const sender = { send: async () => { throw new WhatsAppError("HTTP 400: nope", false); } };
    const n = new Notifier(sql, base, sender as unknown as WhatsAppSender);
    await n.start(T0);
    for (let t = T0; t < T0 + MIN; t += 5 * S) n.observe(reading(t, { alarms: { over_current: true } }), t);
    await n.idle();
    assert.equal(n.stats.failed, 1);
    assert.equal(n.stats.sent, 0);
    assert.match(n.stats.lastError ?? "", /91\*+0001: HTTP 400/);
  });
});
