/**
 * Ingest worker: the only process that talks to the MQTT broker.
 *
 *   broker ──► validate + parse ──► Writer (batched inserts) ──► Postgres
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
import { parseReading, PayloadError } from "../lib/telemetry.ts";
import { config } from "./config.ts";
import { PackRegistry } from "./packs.ts";
import { Writer } from "./writer.ts";

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

// Last arrival-time ts per pack. When the broker delivers a queued backlog
// (after an ingest restart) many messages arrive in the same millisecond;
// without this they would collide on (pack_id, ts) and be dropped as
// duplicates. Device-time readings are left alone: there a collision really
// is a duplicate (QoS 1 redelivery).
const lastArrivalTs = new Map<number, number>();

function accept(packId: number | null, doc: unknown, deviceId: string, topic: string, receivedAt: number) {
  if (packId === null) {
    msgStats.rejected.notAllowed++;
    return;
  }
  try {
    const reading = parseReading(doc, deviceId, topic, receivedAt, config.clockToleranceS);
    if (reading.ts === reading.receivedAt) {
      const prev = lastArrivalTs.get(packId) ?? 0;
      if (reading.ts <= prev) reading.ts = prev + 1;
      lastArrivalTs.set(packId, reading.ts);
    }
    writer.push(packId, reading);
    msgStats.accepted++;
  } catch (e) {
    msgStats.rejected.badPayload++;
    msgStats.lastRejection = `${deviceId}: ${e instanceof PayloadError ? e.message : (e as Error).message}`;
  }
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
  const deviceId =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).device_id
      : undefined;
  if (typeof deviceId !== "string" || !PACK_ID.test(deviceId)) {
    msgStats.rejected.noDeviceId++;
    return;
  }

  const id = packs.lookup(deviceId);
  if (id instanceof Promise) {
    void id.then((pid) => accept(pid, doc, deviceId, topic, receivedAt));
  } else {
    accept(id, doc, deviceId, topic, receivedAt);
  }
}

const client = mqtt.connect(config.mqttUrl, {
  clientId: config.mqttClientId,
  username: config.mqttUsername,
  password: config.mqttPassword,
  // Persistent session: the broker queues QoS 1 messages while we restart.
  clean: false,
  reconnectPeriod: 4000,
  connectTimeout: 10_000,
});

client.on("connect", (ack) => {
  mqttStats.connected = true;
  mqttStats.connects++;
  mqttStats.lastError = null;
  // With a resumed session the broker remembers the subscription, but
  // subscribing again is harmless and covers a changed MQTT_TOPIC.
  client.subscribe(config.mqttTopic, { qos: 1 }, (err, granted) => {
    if (err) mqttStats.lastError = `subscribe failed: ${err.message}`;
    else if (granted?.some((g) => g.qos === 128)) {
      mqttStats.lastError = `broker refused subscription to ${config.mqttTopic}`;
    }
  });
  console.log(
    `[mqtt] connected to ${config.mqttUrl} as ${config.mqttClientId}` +
      `${ack.sessionPresent ? " (resumed session)" : ""}, subscribed to ${config.mqttTopic}`,
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
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  } else if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status()));
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
  packs.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
