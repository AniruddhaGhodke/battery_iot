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

  // Our Mosquitto on the droplet. In Docker there, MQTT_URL is mqtt://mosquitto:1883.
  mqttUrl: process.env.MQTT_URL || "mqtt://159-89-160-225.sslip.io:1883",
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
  // Register any unknown device_id automatically. Only sensible now that the
  // broker needs a login; still off by default.
  autoRegister: process.env.AUTO_REGISTER_DEVICES === "true",

  // Device clock is trusted for ordering only when it says it is synced and
  // is within this many seconds of arrival (see PLAN.md, "Time").
  clockToleranceS: int(process.env.CLOCK_TOLERANCE_S, 300),

  flushIntervalMs: int(process.env.FLUSH_INTERVAL_MS, 1000),
  flushMaxRows: int(process.env.FLUSH_MAX_ROWS, 1000),
  // If the database is down, keep at most this many readings in memory.
  bufferMaxRows: int(process.env.BUFFER_MAX_ROWS, 50_000),

  statusPort: int(process.env.STATUS_PORT, 3101),

  // WhatsApp alerts (ingest/alerts.ts; README, "WhatsApp alerts"). Off unless
  // ALERTS_ENABLED=true, so a local ingest never messages anyone. When off,
  // alerts are still worked out, logged and stored in alert_log.
  alerts: {
    enabled: process.env.ALERTS_ENABLED === "true",
    recipients: list(process.env.ALERT_RECIPIENTS),
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN || "",
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      template: process.env.WHATSAPP_TEMPLATE || "battery_alert",
      language: process.env.WHATSAPP_TEMPLATE_LANG || "en",
      apiVersion: process.env.WHATSAPP_API_VERSION || "v26.0",
    },
    timeZone: process.env.ALERT_TIMEZONE || "Asia/Kolkata",
    timeZoneLabel: process.env.ALERT_TIMEZONE_LABEL ?? "IST",
    mutedPacks: list(process.env.ALERT_MUTE_PACKS),
    alarmDebounceMs: int(process.env.ALERT_DEBOUNCE_S, 10) * 1000,
    cellDebounceMs: int(process.env.ALERT_CELL_DEBOUNCE_S, 120) * 1000,
    clearMs: int(process.env.ALERT_CLEAR_S, 60) * 1000,
    offlineMs: int(process.env.ALERT_OFFLINE_MIN, 10) * 60_000,
    systemDownMs: int(process.env.ALERT_SYSTEM_DOWN_MIN, 3) * 60_000,
    spreadMv: int(process.env.ALERT_SPREAD_MV, 100),
    cooldownMs: int(process.env.ALERT_COOLDOWN_MIN, 15) * 60_000,
    // Safety net against a runaway loop: messages per rolling hour, all recipients.
    maxPerHour: int(process.env.ALERT_MAX_PER_HOUR, 60),
    // The 24 h cause analysis runs before the message goes out; past this it
    // is dropped and the alert is sent without it.
    diagnosisTimeoutMs: int(process.env.ALERT_ANALYSIS_TIMEOUT_S, 8) * 1000,
  },
  // Payloads bigger than this are someone else's traffic, not ours.
  maxPayloadBytes: 64 * 1024,
};
