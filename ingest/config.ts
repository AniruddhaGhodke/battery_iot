/** Ingest configuration, read once from the environment. */

import os from "node:os";

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgres://bms:bms_local@localhost:5433/bms",

  mqttUrl: process.env.MQTT_URL || "mqtt://broker.emqx.io:1883",
  mqttUsername: process.env.MQTT_USERNAME || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  mqttTopic: process.env.MQTT_TOPIC || "emspl/a7f3c2/+/data",
  // Fixed per machine, not random: the broker keeps a persistent session
  // under this id and queues messages while ingest restarts. Two ingest
  // processes must not share it, or they keep kicking each other off.
  mqttClientId: process.env.MQTT_CLIENT_ID || `bms-ingest-${os.hostname()}`,

  // Seeded into the packs table at startup. Packs can be enabled or disabled
  // in the database after that.
  allowedDevices: list(process.env.ALLOWED_DEVICES),
  // Register any unknown device_id automatically. Convenient on a private
  // broker; leave off on a public one.
  autoRegister: process.env.AUTO_REGISTER_DEVICES === "true",

  // Device clock is trusted for ordering only when it says it is synced and
  // is within this many seconds of arrival (see PLAN.md, "Time").
  clockToleranceS: int(process.env.CLOCK_TOLERANCE_S, 300),

  flushIntervalMs: int(process.env.FLUSH_INTERVAL_MS, 1000),
  flushMaxRows: int(process.env.FLUSH_MAX_ROWS, 1000),
  // If the database is down, keep at most this many readings in memory.
  bufferMaxRows: int(process.env.BUFFER_MAX_ROWS, 50_000),

  statusPort: int(process.env.STATUS_PORT, 3101),
  // Payloads bigger than this are someone else's traffic, not ours.
  maxPayloadBytes: 64 * 1024,
};
