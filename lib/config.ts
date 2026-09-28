/** Server-side configuration, read once from the environment. */

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
  mqttUrl: process.env.MQTT_URL || "mqtt://broker.emqx.io:1883",
  mqttUsername: process.env.MQTT_USERNAME || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  mqttTopic: process.env.MQTT_TOPIC || "emspl/a7f3c2/+/data",
  mqttClientId:
    process.env.MQTT_CLIENT_ID ||
    `emspl-nextjs-${Math.random().toString(16).slice(2, 8)}`,
  allowedDevices: list(process.env.ALLOWED_DEVICES),
  historySize: int(process.env.HISTORY_SIZE, 720),
  staleAfterS: int(process.env.STALE_AFTER_S, 60),
  // Payloads bigger than this are someone else's traffic, not ours.
  maxPayloadBytes: 64 * 1024,
};
