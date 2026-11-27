import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MqttClient } from "mqtt";
import {
  ConfigError,
  ConfigManager,
  parseAck,
  subscriptionFor,
  topicFor,
} from "../ingest/commands.ts";
import { CONTROL_ACTIONS, interlockError, validateControl } from "../lib/pack-control.ts";
import {
  CONFIG_FIELDS,
  fieldError,
  FIELD_BY_KEY,
  sendableFields,
  staleAfterMs,
  validateSettings,
} from "../lib/pack-config.ts";

const OPTS = {
  setTopic: "emspl/a7f3c2/{slug}/config/set",
  ackTopic: "emspl/a7f3c2/{slug}/config/ack",
  ackTimeoutMs: 20_000,
  restartGraceMs: 120_000,
  controlSetTopic: "emspl/a7f3c2/{slug}/control/set",
  controlAckTopic: "emspl/a7f3c2/{slug}/control/ack",
  controlExpiryMs: 60_000,
  controlMaxCurrentA: 5,
  otaCommandTopic: "emspl/a7f3c2/{slug}/ota/command",
  otaStatusTopic: "emspl/a7f3c2/{slug}/ota/status",
  firmwareBaseUrl: "https://bms.example.com",
  otaDownloadTimeoutMs: 900_000,
  otaRestartGraceMs: 300_000,
};

const IMAGE = {
  id: 3,
  version: "1.1.0",
  sha256: "a".repeat(64),
  bytes: 1_200_000,
  originalName: "firmware.bin",
  notes: null,
  uploadedBy: "ameya",
  uploadedAt: 0,
};

/** Records inserts and updates, and hands back incrementing ids. */
function fakeSql() {
  const log: { text: string; values: unknown[] }[] = [];
  let nextId = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: unknown, ...values: unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { helper: strings };
    const text = (strings as string[]).join("?").replace(/\s+/g, " ").trim();
    log.push({ text, values });
    if (text.startsWith("insert into config_requests")) {
      return Promise.resolve([{ id: String(nextId++) }]);
    }
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => ({ json: v });
  return { sql, log };
}

type Published = { topic: string; payload: string; opts: { qos?: number; retain?: boolean } };

function fakeClient(published: Published[], fail?: string) {
  return {
    publish: (
      topic: string,
      payload: string,
      opts: { qos?: number; retain?: boolean },
      cb: (e?: Error) => void,
    ) => {
      published.push({ topic, payload, opts });
      cb(fail ? new Error(fail) : undefined);
    },
  } as unknown as MqttClient;
}

function manager(over: Partial<{ slug: string | null; fail: string }> = {}) {
  const published: Published[] = [];
  const silences: { pack: string; until: number }[] = [];
  const { sql, log } = fakeSql();
  const m = new ConfigManager(sql, fakeClient(published, over.fail), OPTS, {
    resolve: (deviceId) =>
      deviceId === "P1"
        ? { packId: 7, slug: over.slug === undefined ? "pack1" : over.slug, uid: "AABBCCDDEEFF" }
        : null,
    expectSilence: (pack, until) => silences.push({ pack, until }),
    latest: () => ({ currentA: 0, ageMs: 1000 }),
  });
  return { m, published, silences, log };
}

const settled = () => new Promise((r) => setImmediate(r));

describe("topics", () => {
  it("fills the slug and builds a subscription", () => {
    assert.equal(topicFor(OPTS.setTopic, "pack1"), "emspl/a7f3c2/pack1/config/set");
    assert.equal(subscriptionFor(OPTS.ackTopic), "emspl/a7f3c2/+/config/ack");
  });
});

describe("validation", () => {
  it("accepts the supported values", () => {
    const v = validateSettings({ can_baud_kbps: 250, telemetry_interval_ms: 5000 });
    assert.ok(v.ok);
    assert.deepEqual(v.settings, { can_baud_kbps: 250, telemetry_interval_ms: 5000 });
    assert.equal(v.restarts, true, "a bitrate change restarts the device");
  });

  it("rejects out-of-range, non-integer and unknown fields", () => {
    for (const bad of [
      { can_baud_kbps: 1000 },
      { telemetry_interval_ms: 999 },
      { telemetry_interval_ms: 300_001 },
      { telemetry_interval_ms: 1500.5 },
      { wifi_password: "hunter2" },
      {},
      "nope",
    ]) {
      assert.equal(validateSettings(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("knows which settings restart the device", () => {
    const v = validateSettings({ telemetry_interval_ms: 10_000 });
    assert.ok(v.ok);
    assert.equal(v.restarts, false);
  });

  it("reports the bound in the message, so the UI can show it", () => {
    const e = fieldError(FIELD_BY_KEY.telemetry_interval_ms, 500);
    // en-IN groups in lakhs, which is what an Indian user expects to read.
    assert.match(e ?? "", /1,000–3,00,000 ms/);
  });
});

describe("staleAfterMs", () => {
  it("never shrinks below the default but follows a long interval", () => {
    assert.equal(staleAfterMs(null, 60_000), 60_000);
    assert.equal(staleAfterMs(5_000, 60_000), 60_000);
    assert.equal(staleAfterMs(300_000, 60_000), 900_000);
  });
});

describe("parseAck", () => {
  it("reads the documented shape", () => {
    const a = parseAck({ device_id: "P1", request_id: 4, status: "accepted" });
    assert.deepEqual(a, { deviceId: "P1", requestId: 4, accepted: true, error: null });
  });

  it("accepts the obvious variants and a string request id", () => {
    assert.equal(parseAck({ result: "rejected", reason: "bad value" }).accepted, false);
    assert.equal(parseAck({ ok: true }).accepted, true);
    assert.equal(parseAck({ accepted: false }).accepted, false);
    assert.equal(parseAck({ request_id: "12" }).requestId, 12);
    assert.equal(parseAck({ status: "rejected", error: "out of range" }).error, "out of range");
  });

  it("says nothing rather than guessing when the device does not report a result", () => {
    assert.equal(parseAck({ device_id: "P1" }).accepted, null);
    assert.equal(parseAck("junk").deviceId, null);
  });
});

describe("submit", () => {
  it("publishes at QoS 1 without retain, and records the request", async () => {
    const { m, published, log } = manager();
    const r = await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();

    assert.equal(published.length, 1);
    assert.equal(published[0].topic, "emspl/a7f3c2/pack1/config/set");
    assert.deepEqual(JSON.parse(published[0].payload), {
      target_uid: "AABBCCDDEEFF",
      telemetry_interval_ms: 10_000,
    });
    assert.equal(published[0].opts.qos, 1);
    assert.equal(published[0].opts.retain, false, "a retained command would be reapplied on reconnect");
    assert.equal(r.id, 1);
    assert.equal(m.openRequests()[0].status, "sent");
    assert.ok(log.some((q) => q.text.startsWith("insert into config_requests")));
  });

  it("refuses a pack it cannot address", async () => {
    await assert.rejects(
      () => manager().m.submit("NOPE", { telemetry_interval_ms: 5000 }, "admin"),
      (e: ConfigError) => e.status === 404,
    );
    await assert.rejects(
      () => manager({ slug: null }).m.submit("P1", { telemetry_interval_ms: 5000 }, "admin"),
      (e: ConfigError) => e.status === 409 && /no topic known/.test(e.message),
    );
  });

  it("reports validation errors without publishing", async () => {
    const { m, published } = manager();
    await assert.rejects(
      () => m.submit("P1", { telemetry_interval_ms: 10 }, "admin"),
      (e: ConfigError) => e.status === 400 && e.details.length === 1,
    );
    assert.equal(published.length, 0);
  });

  it("will not queue a second request for a pack that has not answered", async () => {
    const { m } = manager();
    await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    await assert.rejects(
      () => m.submit("P1", { telemetry_interval_ms: 20_000 }, "admin"),
      (e: ConfigError) => e.status === 409,
    );
  });

  it("marks the request failed when the publish does not get through", async () => {
    const { m } = manager({ fail: "not authorized" });
    await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    assert.equal(m.openRequests().length, 0);
    assert.equal(m.stats.failed, 1);
  });
});

describe("acknowledgement", () => {
  it("applies a non-restarting setting straight away", async () => {
    const { m } = manager();
    const r = await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { device_id: "P1", request_id: r.id, status: "accepted" });
    await settled();
    assert.equal(m.stats.applied, 1);
    assert.equal(m.openRequests().length, 0);
  });

  it("waits for telemetry after a restart, and tells the alert engine to expect the gap", async () => {
    const { m, silences } = manager();
    const r = await m.submit("P1", { can_baud_kbps: 250 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { device_id: "P1", request_id: r.id, status: "accepted" });
    await settled();

    assert.equal(m.openRequests()[0].status, "restarting");
    assert.equal(m.stats.applied, 0, "not applied until the pack is back");
    assert.equal(silences.length, 1, "the offline alert must be suppressed meanwhile");
    assert.equal(silences[0].pack, "P1");

    m.onTelemetry("P1");
    await settled();
    assert.equal(m.stats.applied, 1);
    assert.equal(m.openRequests().length, 0);
  });

  it("records a rejection with the device's reason", async () => {
    const { m } = manager();
    const r = await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", {
      device_id: "P1",
      request_id: r.id,
      status: "rejected",
      error: "interval out of range",
    });
    await settled();
    assert.equal(m.stats.rejected, 1);
  });

  it("matches on the device when the firmware sends no request id", async () => {
    const { m } = manager();
    await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { device_id: "P1", status: "accepted" });
    await settled();
    assert.equal(m.stats.applied, 1);
  });

  it("falls back to the topic when the payload names no device either", async () => {
    const { m } = manager();
    await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { status: "accepted" });
    await settled();
    assert.equal(m.stats.applied, 1);
  });

  it("ignores an acknowledgement it cannot place", async () => {
    const { m } = manager();
    m.handleAck("emspl/a7f3c2/pack9/config/ack", { device_id: "OTHER", status: "accepted" });
    await settled();
    assert.equal(m.stats.applied, 0);
  });
});

describe("timeouts", () => {
  it("gives up when the device never answers", async () => {
    const { m } = manager();
    const r = await m.submit("P1", { telemetry_interval_ms: 10_000 }, "admin");
    await settled();
    m.tick(r.requestedAt + OPTS.ackTimeoutMs - 1);
    assert.equal(m.stats.timedOut, 0);
    m.tick(r.requestedAt + OPTS.ackTimeoutMs);
    await settled();
    assert.equal(m.stats.timedOut, 1);
  });

  it("gives up when an acknowledged restart never comes back", async () => {
    const { m } = manager();
    const r = await m.submit("P1", { can_baud_kbps: 250 }, "admin");
    await settled();
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { request_id: r.id, status: "accepted" });
    await settled();
    const acked = m.openRequests()[0].ackedAt ?? 0;
    m.tick(acked + OPTS.restartGraceMs);
    await settled();
    assert.equal(m.stats.timedOut, 1);
    assert.equal(m.stats.applied, 0);
  });
});

describe("pending fields", () => {
  it("refuses a setting the firmware does not forward yet, even if it is in range", () => {
    const v = validateSettings({ bms_over_discharge_mv: 2500 });
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.errors[0] : "", /does not forward this yet/);
  });

  it("refuses the whole request if any field is pending", () => {
    const v = validateSettings({ telemetry_interval_ms: 5000, bms_over_charge_mv: 3650 });
    assert.equal(v.ok, false);
  });

  it("only exposes the gateway settings as sendable today", () => {
    assert.deepEqual(
      sendableFields().map((f) => f.key),
      ["device_id", "can_baud_kbps", "telemetry_interval_ms"],
    );
  });

  it("offers 250 kbps only, so the BMS link cannot be silenced from here", () => {
    const f = FIELD_BY_KEY.can_baud_kbps;
    assert.equal(f.kind, "enum");
    assert.deepEqual(f.kind === "enum" ? f.values : [], [250]);
    assert.equal(validateSettings({ can_baud_kbps: 500 }).ok, false);
    assert.equal(validateSettings({ can_baud_kbps: 250 }).ok, true);
  });

  it("gives every BMS field a CAN command id, so firmware knows what to write", () => {
    for (const f of CONFIG_FIELDS.filter((x) => x.target === "bms")) {
      assert.match(f.canCommand ?? "", /^0x[0-9A-F]{2}$/, `${f.key} has no CAN command`);
    }
  });

  it("keeps the inverted balance encoding from the protocol", () => {
    // 0x08 is the one command where 2 means on and 1 means off.
    const f = FIELD_BY_KEY.bms_auto_balance;
    assert.equal(f.kind, "bool");
    if (f.kind === "bool") {
      assert.equal(f.onValue, 2);
      assert.equal(f.offValue, 1);
    }
  });

  it("bounds every protection setpoint", () => {
    for (const f of CONFIG_FIELDS.filter((x) => x.group === "protection")) {
      assert.ok(f.kind === "range" || f.kind === "enum", `${f.key} is unbounded`);
      if (f.kind === "range") {
        assert.ok(f.min < f.max, `${f.key} has a nonsense range`);
        assert.ok(fieldError(f, f.min - 1) !== null, `${f.key} accepts below its minimum`);
        assert.ok(fieldError(f, f.max + 1) !== null, `${f.key} accepts above its maximum`);
      }
    }
  });
});

describe("channel control", () => {
  it("has one channel command, not separate charge and discharge", () => {
    // The 192S protocol reports both MOS states but offers only 0x07 to switch.
    assert.equal(CONTROL_ACTIONS.length, 1);
    assert.equal(CONTROL_ACTIONS[0].canCommand, "0x07");
    assert.equal(CONTROL_ACTIONS[0].onValue, 1);
    assert.equal(CONTROL_ACTIONS[0].offValue, 2);
  });

  it("refuses to switch until the firmware supports it", () => {
    const v = validateControl("channel", "off");
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.error : "", /does not forward this yet/);
  });

  it("rejects an unknown action or value", () => {
    assert.equal(validateControl("explode", "on").ok, false);
    assert.equal(validateControl("channel", "maybe").ok, false);
  });

  describe("interlock", () => {
    const fresh = (currentA: number | null) => ({ currentA, ageMs: 1_000 });

    it("will not open the channel under load", () => {
      const e = interlockError("off", fresh(-42));
      assert.match(e ?? "", /42\.0 A/);
      assert.match(e ?? "", /arc and weld/);
    });

    it("allows opening at rest", () => {
      assert.equal(interlockError("off", fresh(0.4)), null);
      assert.equal(interlockError("off", fresh(-4.9)), null);
    });

    it("allows closing even under load, since an open channel carries nothing", () => {
      assert.equal(interlockError("on", fresh(-80)), null);
    });

    it("will not switch blind on stale or missing telemetry", () => {
      assert.match(interlockError("off", null) ?? "", /state is unknown/);
      assert.match(interlockError("on", null) ?? "", /state is unknown/);
      assert.match(interlockError("off", { currentA: 0, ageMs: 10 * 60_000 }) ?? "", /600 s old/);
    });

    it("will not open when the pack reports no current at all", () => {
      assert.match(interlockError("off", fresh(null)) ?? "", /not reporting current/);
    });
  });

  it("carries an expiry, so a queued command cannot fire late", async () => {
    // The firmware must drop a command past expires_at; the broker keeps
    // queued messages for an offline device for up to 14 days.
    const { m, published } = manager();
    // Reach past the pending flag the way enabling the field later will.
    const spec = CONTROL_ACTIONS[0];
    const wasPending = spec.pending;
    (spec as { pending: boolean }).pending = false;
    try {
      const before = Date.now();
      await m.submitControl("P1", "channel", "off", "admin");
      await settled();
      assert.equal(published.length, 1);
      assert.equal(published[0].topic, "emspl/a7f3c2/pack1/control/set");
      assert.equal(published[0].opts.retain, false);
      const body = JSON.parse(published[0].payload);
      assert.equal(body.action, "channel");
      assert.equal(body.value, "off");
      assert.ok(body.expires_at >= before + OPTS.controlExpiryMs);
      assert.ok(body.request_id > 0);
    } finally {
      (spec as { pending: boolean }).pending = wasPending;
    }
  });

  it("enforces the interlock on the server, not just in the browser", async () => {
    const spec = CONTROL_ACTIONS[0];
    const wasPending = spec.pending;
    (spec as { pending: boolean }).pending = false;
    try {
      const published: { topic: string; payload: string; opts: { retain?: boolean } }[] = [];
      const { sql } = fakeSql();
      const m = new ConfigManager(sql, fakeClient(published), OPTS, {
        resolve: () => ({ packId: 7, slug: "pack1", uid: "AABBCCDDEEFF" }),
        expectSilence: () => {},
        latest: () => ({ currentA: -60, ageMs: 500 }),
      });
      await assert.rejects(
        () => m.submitControl("P1", "channel", "off", "admin"),
        (e: ConfigError) => e.status === 409 && /arc and weld/.test(e.message),
      );
      assert.equal(published.length, 0, "nothing may be published when the interlock blocks");
    } finally {
      (spec as { pending: boolean }).pending = wasPending;
    }
  });
});

describe("firmware updates", () => {
  it("names the target by UID, with an https URL and the image's hash", async () => {
    const { m, published, silences } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    assert.equal(published.length, 1);
    assert.equal(published[0].topic, "emspl/a7f3c2/pack1/ota/command");
    assert.equal(published[0].opts.retain, false, "a retained OTA command would reflash on reconnect");
    assert.deepEqual(JSON.parse(published[0].payload), {
      target_uid: "AABBCCDDEEFF",
      version: "1.1.0",
      url: `https://bms.example.com/firmware/${IMAGE.sha256}.bin`,
      sha256: IMAGE.sha256,
    });
    assert.equal(req.kind, "ota");
    // The download blocks the firmware's loop and the reboot follows, so the
    // pack is quiet for minutes: without this it would be reported offline.
    assert.equal(silences.length, 1);
    assert.ok(silences[0].until >= Date.now() + OPTS.otaDownloadTimeoutMs);
  });

  it("refuses to start without a configured firmware URL", async () => {
    const { sql } = fakeSql();
    const m = new ConfigManager(sql, fakeClient([]), { ...OPTS, firmwareBaseUrl: "" }, {
      resolve: () => ({ packId: 7, slug: "pack1", uid: "AABBCCDDEEFF" }),
      expectSilence: () => {},
      latest: () => null,
    });
    await assert.rejects(
      () => m.submitOta("P1", IMAGE, "ameya"),
      (e: ConfigError) => e.status === 503 && /SITE_ADDRESS/.test(e.message),
    );
  });

  it("refuses a URL the device would not fetch", async () => {
    const { sql } = fakeSql();
    const m = new ConfigManager(sql, fakeClient([]), { ...OPTS, firmwareBaseUrl: "http://bms.local" }, {
      resolve: () => ({ packId: 7, slug: "pack1", uid: "AABBCCDDEEFF" }),
      expectSilence: () => {},
      latest: () => null,
    });
    await assert.rejects(
      () => m.submitOta("P1", IMAGE, "ameya"),
      (e: ConfigError) => /HTTPS/.test(e.message),
    );
  });

  it("refuses a pack whose hardware UID is unknown", async () => {
    const { sql } = fakeSql();
    const published: Published[] = [];
    const m = new ConfigManager(sql, fakeClient(published), OPTS, {
      resolve: () => ({ packId: 7, slug: "pack1", uid: null }),
      expectSilence: () => {},
      latest: () => null,
    });
    for (const send of [
      () => m.submitOta("P1", IMAGE, "ameya"),
      () => m.submit("P1", { telemetry_interval_ms: 10_000 }, "ameya"),
    ]) {
      await assert.rejects(send, (e: ConfigError) => e.status === 409 && /target_uid/.test(e.message));
    }
    assert.equal(published.length, 0, "a command with no target_uid is ignored by every device");
  });

  it("follows the device from downloading to installed to applied", async () => {
    const { m, silences } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();

    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "downloading",
      version: "1.1.0",
      current_version: "1.0.0",
    });
    assert.equal(req.status, "downloading");

    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "installed",
      version: "1.1.0",
    });
    assert.equal(req.status, "restarting", "flashed is not applied until it comes back");

    // Back, reporting the version we sent.
    m.onTelemetry("P1", "1.1.0");
    await settled();
    assert.equal(req.status, "applied");
    assert.equal(m.stats.applied, 1);
    // Normal offline alerting resumes as soon as it is back.
    assert.ok(silences.at(-1)!.until <= Date.now());
  });

  it("calls it failed when the pack comes back on the old version", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "installed",
      version: "1.1.0",
    });
    // A board that fails its own check on boot rolls back and publishes again
    // as if nothing happened. Only the version tells us.
    m.onTelemetry("P1", "1.0.0");
    await settled();
    assert.equal(req.status, "failed");
    assert.match(req.error ?? "", /rolled back/);
  });

  it("does not call an update applied with no version to check", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "installed",
      version: "1.1.0",
    });
    m.onTelemetry("P1", null);
    await settled();
    assert.equal(req.status, "restarting");
  });

  it("reports what the device said when it refuses", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "rejected",
      version: "1.1.0",
      message: "OTA root CA is not configured in include/otaCredentials.h",
    });
    await settled();
    assert.equal(req.status, "rejected");
    assert.match(req.error ?? "", /otaCredentials\.h/);
  });

  it("gives the download minutes, not the acknowledgement timeout", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    m.handleOtaStatus("emspl/a7f3c2/pack1/ota/status", {
      device_uid: "AABBCCDDEEFF",
      status: "downloading",
    });
    m.tick(Date.now() + OPTS.ackTimeoutMs + 1000);
    assert.equal(req.status, "downloading", "a 1.5 MB download outlasts the ack timeout");
    m.tick(Date.now() + OPTS.otaDownloadTimeoutMs + 1000);
    await settled();
    assert.equal(req.status, "timeout");
  });

  it("explains a silent timeout, since a bad command is never answered", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    m.tick(Date.now() + OPTS.ackTimeoutMs + 1);
    await settled();
    assert.equal(req.status, "timeout");
    assert.match(req.error ?? "", /refused the command without reporting why/);
  });

  it("will not start a second rollout while one is in flight", async () => {
    const { m } = manager();
    await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    await assert.rejects(
      () => m.submitOta("P1", IMAGE, "ameya"),
      (e: ConfigError) => e.status === 409 && /still waiting/.test(e.message),
    );
    await assert.rejects(
      () => m.submit("P1", { telemetry_interval_ms: 10_000 }, "ameya"),
      (e: ConfigError) => e.status === 409,
    );
  });

  it("never lets a late write move a finished request backwards", async () => {
    const { m, log } = manager();
    await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    // Two updates for one request can be in flight at once — a device on the
    // same network answers in under a millisecond — and the pool gives no
    // ordering between connections. Every step but the last is guarded so a
    // late "sent" cannot overwrite the outcome.
    const sent = log.find((l) => l.text.startsWith("update config_requests") && l.values.length > 1);
    assert.ok(sent, log.map((l) => l.text).join("\n"));
    assert.match(sent.text, /status = any\(/);
  });

  it("does not mistake a config acknowledgement for an OTA status", async () => {
    const { m } = manager();
    const req = await m.submitOta("P1", IMAGE, "ameya");
    await settled();
    // Same pack, same moment, a configuration ack arrives: it must not be
    // matched to the open rollout.
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { device_id: "P1", status: "accepted" });
    await settled();
    assert.equal(req.status, "sent");
  });
});

describe("renaming a pack", () => {
  it("matches the acknowledgement that comes back under the new name", async () => {
    const { m } = manager();
    const req = await m.submit("P1", { device_id: "EM_PACK_40S_02" }, "ameya");
    await settled();
    // The device applies the rename and acknowledges as its new self.
    m.handleAck("emspl/a7f3c2/pack1/config/ack", {
      device_id: "EM_PACK_40S_02",
      status: "accepted",
      device_id_changed: true,
    });
    await settled();
    assert.equal(req.status, "applied", "the ack is matched on the topic when the name has changed");
  });

  it("refuses to guess when two packs share a topic", async () => {
    const { sql } = fakeSql();
    const published: Published[] = [];
    // Two boards, one hardcoded topic — which is how the firmware ships.
    const m = new ConfigManager(sql, fakeClient(published), OPTS, {
      resolve: (d: string) => ({ packId: d === "P1" ? 7 : 8, slug: "pack1", uid: `AABBCCDDEE0${d.at(-1)}` }),
      expectSilence: () => {},
      latest: () => null,
    });
    const a = await m.submit("P1", { device_id: "RENAMED_1" }, "ameya");
    const b = await m.submit("P2", { device_id: "RENAMED_2" }, "ameya");
    await settled();
    // An ack under a name we have never seen: it belongs to one of the two
    // renames and there is no way to tell which.
    m.handleAck("emspl/a7f3c2/pack1/config/ack", { device_id: "RENAMED_1", status: "accepted" });
    await settled();
    assert.equal(a.status, "sent");
    assert.equal(b.status, "sent");
  });

  it("sends the new name as text, within the firmware's own limits", () => {
    const v = validateSettings({ device_id: "EM_PACK_40S_02" });
    assert.ok(v.ok);
    assert.deepEqual(v.settings, { device_id: "EM_PACK_40S_02" });
    assert.equal(v.restarts, false);
    for (const bad of ["", "   ", "a b", "pack#1", "x".repeat(32), 42]) {
      assert.equal(validateSettings({ device_id: bad }).ok, false, JSON.stringify(bad));
    }
  });
});
