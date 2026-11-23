/**
 * Ingest worker: the only process that talks to the MQTT broker.
 *
 *   broker ──► validate + parse ──► Writer (batched inserts) ──► Postgres
 *
 * Every accepted reading also goes to the alert engine (notifier.ts), which
 * sends WhatsApp messages for alarms, silent packs and outages.
 *
 * It is also the only process that publishes: remote configuration arrives
 * over HTTP from the web container and goes out on the config topic
 * (commands.ts), so the broker password never leaves this container.
 *
 * Also serves GET /status and /health on STATUS_PORT. In Docker that port
 * is only reachable from the web container, never published.
 *
 * Run: `npm run ingest:dev` (watch mode) or `node ingest/main.ts`.
 */

import http from "node:http";
import mqtt from "mqtt";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import type { IngestStatus } from "../lib/ingest-status.ts";
import { parseReading, PayloadError, type Reading } from "../lib/telemetry.ts";
import { ConfigError, ConfigManager, subscriptionFor } from "./commands.ts";
import { config } from "./config.ts";
import { diagnose } from "../lib/diagnose.ts";
import { gatherWindow } from "./diagnose-data.ts";
import { type DiagnoseFn, Notifier, sendTestAlert } from "./notifier.ts";
import { PackRegistry } from "./packs.ts";
import { Writer } from "./writer.ts";

// `node ingest.mjs --test-alert` (in the container) or `npm run alert:test`:
// send one WhatsApp test message and exit, without touching MQTT.
if (process.argv.includes("--test-alert")) {
  process.exit((await sendTestAlert(config.alerts)) ? 0 : 1);
}

const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const startedAt = Date.now();
const mqttStats: IngestStatus["mqtt"] = {
  connected: false,
  broker: config.mqttUrl,
  topic: config.mqttTopic,
  clientId: config.mqttClientId,
  connects: 0,
  disconnects: 0,
  lastError: null,
  lastMessageAt: null,
};
const msgStats: IngestStatus["messages"] = {
  received: 0,
  accepted: 0,
  rejected: { tooLarge: 0, notJson: 0, noDeviceId: 0, notAllowed: 0, badPayload: 0 },
  lastRejection: null,
};

const sql = postgres(config.databaseUrl, {
  max: 3,
  idle_timeout: 60,
  onnotice: () => {},
});

async function waitForDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await migrate(sql);
      if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith("migration ")) throw e; // a broken migration won't fix itself
      const wait = Math.min(attempt * 2, 15);
      console.warn(`[db] not reachable (${msg}), retrying in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

await waitForDatabase();

const packs = new PackRegistry(sql, config.autoRegister);
await packs.start(config.allowedDevices);

const writer = new Writer(sql, {
  intervalMs: config.flushIntervalMs,
  maxRows: config.flushMaxRows,
  bufferMax: config.bufferMaxRows,
});
writer.start();

/** 24 h cause analysis for a raised battery alert (lib/diagnose.ts). */
const diagnoseAlert: DiagnoseFn = async (condition, deviceId) => {
  const id = packs.lookup(deviceId);
  if (typeof id !== "number") return null;
  const window = await gatherWindow(sql, id, deviceId, condition, config.alerts.spreadMv);
  return diagnose(condition, window);
};

const notifier = new Notifier(sql, config.alerts, undefined, diagnoseAlert);
await notifier.start();
const alertTimer = setInterval(() => {
  configs?.tick();
  notifier.tick(packs.enabledDevices(), {
    mqttConnected: mqttStats.connected,
    mqttError: mqttStats.lastError,
    // Only an outage while readings pile up; a single bad row also sets lastError.
    dbError: writer.stats.buffered > 0 ? writer.stats.lastError : null,
    buffered: writer.stats.buffered,
  });
}, 5_000);

// Where the pack's own segment sits in the telemetry topic, e.g. index 2 in
// emspl/a7f3c2/+/data. Used to learn which topic each device publishes on.
const SLUG_INDEX = config.mqttTopic.split("/").indexOf("+");
const ACK_SUBSCRIPTION = subscriptionFor(config.remoteConfig.ackTopic);
const ACK_PREFIX = config.remoteConfig.ackTopic.split("{slug}")[0];
const ACK_SUFFIX = config.remoteConfig.ackTopic.split("{slug}").at(-1) ?? "";

/** An acknowledgement topic rather than telemetry. */
function isAckTopic(topic: string): boolean {
  return topic.startsWith(ACK_PREFIX) && topic.endsWith(ACK_SUFFIX) && topic !== ACK_PREFIX;
}

let configs: ConfigManager | undefined;

// Last arrival-time ts per pack. When the broker delivers a queued backlog
// (after an ingest restart) many messages arrive in the same millisecond;
// without this they would collide on (pack_id, ts) and be dropped as
// duplicates. Device-time readings are left alone: there a collision really
// is a duplicate (QoS 1 redelivery).
const lastArrivalTs = new Map<number, number>();

function parse(doc: unknown, deviceId: string, topic: string, receivedAt: number): Reading | null {
  try {
    return parseReading(doc, deviceId, topic, receivedAt, config.clockToleranceS);
  } catch (e) {
    msgStats.rejected.badPayload++;
    msgStats.lastRejection = `${deviceId}: ${e instanceof PayloadError ? e.message : (e as Error).message}`;
    return null;
  }
}

function store(packId: number | null, reading: Reading) {
  if (packId === null) {
    msgStats.rejected.notAllowed++;
    return;
  }
  if (reading.ts === reading.receivedAt) {
    const prev = lastArrivalTs.get(packId) ?? 0;
    if (reading.ts <= prev) reading.ts = prev + 1;
    lastArrivalTs.set(packId, reading.ts);
  }
  writer.push(packId, reading);
  msgStats.accepted++;
  notifier.observe(reading);
  if (SLUG_INDEX >= 0) {
    const slug = reading.topic.split("/")[SLUG_INDEX];
    if (slug) packs.noteTopic(reading.packId, slug);
  }
  configs?.onTelemetry(reading.packId);
}

function handleMessage(topic: string, payload: Buffer) {
  const receivedAt = Date.now();
  msgStats.received++;
  mqttStats.lastMessageAt = receivedAt;

  if (payload.length > config.maxPayloadBytes) {
    msgStats.rejected.tooLarge++;
    return;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(payload.toString("utf8"));
  } catch {
    msgStats.rejected.notJson++;
    return;
  }
  // Configuration acknowledgements share the connection but are not readings.
  if (isAckTopic(topic)) {
    configs?.handleAck(topic, doc);
    return;
  }
  const deviceId =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).device_id
      : undefined;
  if (typeof deviceId !== "string" || !PACK_ID.test(deviceId)) {
    msgStats.rejected.noDeviceId++;
    return;
  }

  const id = packs.lookup(deviceId);
  if (id === null) {
    msgStats.rejected.notAllowed++;
    return;
  }
  const reading = parse(doc, deviceId, topic, receivedAt);
  if (!reading) return;
  if (id === undefined) {
    // New device, auto-register on: registered only now its payload is valid.
    void packs.register(deviceId).then((pid) => store(pid, reading));
  } else {
    store(id, reading);
  }
}

const client = mqtt.connect(config.mqttUrl, {
  clientId: config.mqttClientId,
  username: config.mqttUsername,
  password: config.mqttPassword,
  // Persistent session: the broker queues QoS 1 messages while we restart.
  clean: false,
  reconnectPeriod: 4000,
  // Keep retrying after "Not authorized" too (mqtt.js gives up by default),
  // so a fixed broker login is picked up without restarting ingest.
  reconnectOnConnackError: true,
  connectTimeout: 10_000,
});

client.on("connect", (ack) => {
  mqttStats.connected = true;
  mqttStats.connects++;
  mqttStats.lastError = null;
  // With a resumed session the broker remembers the subscription, but
  // subscribing again is harmless and covers a changed MQTT_TOPIC.
  client.subscribe([config.mqttTopic, ACK_SUBSCRIPTION], { qos: 1 }, (err, granted) => {
    if (err) mqttStats.lastError = `subscribe failed: ${err.message}`;
    else {
      const refused = granted?.filter((g) => g.qos === 128).map((g) => g.topic) ?? [];
      if (refused.length) {
        // Almost always the ACL: see README, "Remote configuration".
        mqttStats.lastError = `broker refused subscription to ${refused.join(", ")}`;
      }
    }
  });
  console.log(
    `[mqtt] connected to ${config.mqttUrl} as ${config.mqttClientId}` +
      `${ack.sessionPresent ? " (resumed session)" : ""}, subscribed to ${config.mqttTopic} and ${ACK_SUBSCRIPTION}`,
  );
});
client.on("close", () => {
  if (mqttStats.connected) mqttStats.disconnects++;
  mqttStats.connected = false;
});
client.on("error", (err) => {
  // ENOTFOUND here is almost always DNS - see README, "No data".
  mqttStats.lastError = err.message;
  console.warn(`[mqtt] ${err.message}`);
});
configs = new ConfigManager(sql, client, config.remoteConfig, {
  resolve: (deviceId) => packs.resolve(deviceId),
  expectSilence: (deviceId, until) => notifier.expectSilence(deviceId, until),
});
await configs.start();

client.on("message", handleMessage);

if (!config.allowedDevices.length && !config.autoRegister && packs.count === 0) {
  console.warn(
    "[packs] no packs enabled: set ALLOWED_DEVICES, or AUTO_REGISTER_DEVICES=true on a private broker",
  );
}

function status(): IngestStatus {
  return {
    startedAt,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    mqtt: mqttStats,
    messages: msgStats,
    writer: writer.stats,
    packs: {
      enabled: packs.count,
      autoRegister: config.autoRegister,
      unknown: [...packs.unknown.entries()].map(([deviceId, u]) => ({ deviceId, ...u })),
    },
    alerts: { ...notifier.stats, active: notifier.active() },
    config: {
      ...(configs?.stats ?? { submitted: 0, sent: 0, applied: 0, rejected: 0, timedOut: 0, failed: 0 }),
      open: (configs?.openRequests() ?? []).map((r) => ({
        id: r.id,
        deviceId: r.deviceId,
        status: r.status,
        requestedAt: r.requestedAt,
      })),
    },
  };
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const MAX_BODY = 16 * 1024;

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ConfigError("request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ConfigError("body is not JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

/**
 * POST /config — the only way into the broker from outside this container.
 * Reachable from the web container alone; never published (compose).
 */
async function postConfig(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await readJson(req)) as Record<string, unknown>;
    const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
    if (!deviceId) throw new ConfigError("device_id is required", 400);
    if (!configs) throw new ConfigError("ingest is still starting up", 503);
    const by = typeof body.requested_by === "string" && body.requested_by.trim()
      ? body.requested_by.trim().slice(0, 100)
      : "unknown";
    const r = await configs.submit(deviceId, body.settings, by);
    json(res, 202, {
      id: r.id,
      device_id: r.deviceId,
      status: r.status,
      settings: r.settings,
      restarts: r.restarts,
    });
  } catch (e) {
    if (e instanceof ConfigError) json(res, e.status, { error: e.message, details: e.details });
    else {
      console.warn(`[config] request failed: ${(e as Error).message}`);
      json(res, 500, { error: (e as Error).message });
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/config") {
    void postConfig(req, res);
  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  } else if (req.url === "/status") {
    json(res, 200, status());
  } else {
    res.writeHead(404).end();
  }
});
server.listen(config.statusPort, () => {
  console.log(`[ingest] status on :${config.statusPort}/status`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[ingest] ${signal}: flushing ${writer.stats.buffered} buffered readings`);
  await new Promise<void>((r) => client.end(false, {}, () => r()));
  await writer.drain();
  clearInterval(alertTimer);
  // Let a message being sent finish, but don't outlive Docker's grace period.
  await Promise.race([notifier.idle(), new Promise((r) => setTimeout(r, 5_000))]);
  packs.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
