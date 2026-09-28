/**
 * The one long-lived MQTT subscriber, and the in-memory data it collects.
 *
 * Next.js route handlers only run per request, so they cannot stay subscribed
 * to a broker. Instead this module opens a single connection when the server
 * boots (see instrumentation.ts) and every route reads from it.
 *
 * It is stored on globalThis because `next dev` re-evaluates modules on every
 * edit; without that, each hot reload would open another connection and the
 * broker would see a growing pile of duplicate clients.
 *
 * Memory only, for now: a restart clears it. Persistent history is in TODO.md.
 */

import mqtt, { type MqttClient } from "mqtt";
import { config } from "./config";
import { parseReading, PayloadError, type Reading } from "./telemetry";

type PackState = {
  latest: Reading;
  history: Reading[];
  messages: number;
  firstSeen: number;
};

export type StoreStats = {
  connected: boolean;
  broker: string;
  topic: string;
  clientId: string;
  allowlist: string[];
  startedAt: number;
  connects: number;
  disconnects: number;
  lastError: string | null;
  lastMessageAt: number | null;
  received: number;
  accepted: number;
  rejected: {
    tooLarge: number;
    notJson: number;
    noDeviceId: number;
    notAllowed: number;
    badPayload: number;
  };
};

type Store = {
  client: MqttClient | null;
  packs: Map<string, PackState>;
  stats: StoreStats;
};

const g = globalThis as unknown as { __bmsStore?: Store };

function newStore(): Store {
  return {
    client: null,
    packs: new Map(),
    stats: {
      connected: false,
      broker: config.mqttUrl,
      topic: config.mqttTopic,
      clientId: config.mqttClientId,
      allowlist: config.allowedDevices,
      startedAt: Date.now(),
      connects: 0,
      disconnects: 0,
      lastError: null,
      lastMessageAt: null,
      received: 0,
      accepted: 0,
      rejected: { tooLarge: 0, notJson: 0, noDeviceId: 0, notAllowed: 0, badPayload: 0 },
    },
  };
}

const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function handleMessage(store: Store, topic: string, payload: Buffer) {
  const s = store.stats;
  const receivedAt = Date.now();
  s.received++;
  s.lastMessageAt = receivedAt;

  if (payload.length > config.maxPayloadBytes) {
    s.rejected.tooLarge++;
    return;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(payload.toString("utf8"));
  } catch {
    s.rejected.notJson++;
    return;
  }

  const deviceId =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).device_id
      : undefined;
  if (typeof deviceId !== "string" || !PACK_ID.test(deviceId)) {
    s.rejected.noDeviceId++;
    return;
  }
  if (config.allowedDevices.length && !config.allowedDevices.includes(deviceId)) {
    s.rejected.notAllowed++;
    return;
  }

  let reading: Reading;
  try {
    reading = parseReading(doc, deviceId, topic, receivedAt);
  } catch (e) {
    s.rejected.badPayload++;
    if (e instanceof PayloadError) s.lastError = `${deviceId}: ${e.message}`;
    return;
  }

  const existing = store.packs.get(deviceId);
  if (existing) {
    existing.latest = reading;
    existing.history.push(reading);
    if (existing.history.length > config.historySize) {
      existing.history.splice(0, existing.history.length - config.historySize);
    }
    existing.messages++;
  } else {
    store.packs.set(deviceId, {
      latest: reading,
      history: [reading],
      messages: 1,
      firstSeen: receivedAt,
    });
  }
  s.accepted++;
}

/** Idempotent: safe to call from instrumentation and from every route. */
export function getStore(): Store {
  if (!g.__bmsStore) g.__bmsStore = newStore();
  const store = g.__bmsStore;
  if (store.client) return store;

  const client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    username: config.mqttUsername,
    password: config.mqttPassword,
    clean: true,
    reconnectPeriod: 4000,
    connectTimeout: 10_000,
  });
  store.client = client;

  client.on("connect", () => {
    store.stats.connected = true;
    store.stats.connects++;
    store.stats.lastError = null;
    client.subscribe(config.mqttTopic, { qos: 0 }, (err, granted) => {
      if (err) {
        store.stats.lastError = `subscribe failed: ${err.message}`;
      } else if (granted?.some((g) => g.qos === 128)) {
        store.stats.lastError = `broker refused subscription to ${config.mqttTopic}`;
      }
    });
    console.log(`[mqtt] connected to ${config.mqttUrl}, subscribed to ${config.mqttTopic}`);
  });
  client.on("close", () => {
    if (store.stats.connected) store.stats.disconnects++;
    store.stats.connected = false;
  });
  client.on("error", (err) => {
    // ENOTFOUND here is almost always DNS - see README, "No data".
    store.stats.lastError = err.message;
    console.warn(`[mqtt] ${err.message}`);
  });
  client.on("message", (topic, payload) => handleMessage(store, topic, payload));

  if (!config.allowedDevices.length) {
    console.warn(
      "[mqtt] ALLOWED_DEVICES is empty: any device_id on this topic will be shown. " +
        "On a public broker, set it.",
    );
  }
  return store;
}

// ---- read API used by the route handlers ---------------------------------

export function isOnline(p: PackState, now = Date.now()) {
  return now - p.latest.receivedAt < config.staleAfterS * 1000;
}

export function listPacks() {
  const store = getStore();
  const now = Date.now();
  return [...store.packs.entries()]
    .map(([id, p]) => ({
      packId: id,
      online: isOnline(p, now),
      lastSeen: p.latest.receivedAt,
      messages: p.messages,
      seriesCount: p.latest.seriesCount,
      voltage: p.latest.voltage,
      current: p.latest.current,
      soc: p.latest.soc,
      spreadMv: p.latest.spreadMv,
      activeAlarms: p.latest.activeAlarms,
    }))
    .sort((a, b) => a.packId.localeCompare(b.packId));
}

export function getPack(id: string) {
  const p = getStore().packs.get(id);
  if (!p) return null;
  return {
    packId: id,
    online: isOnline(p),
    messages: p.messages,
    firstSeen: p.firstSeen,
    latest: p.latest,
  };
}

/** Compact series for charts; drops the per-cell arrays except min/max. */
export function getRecent(id: string, limit: number) {
  const p = getStore().packs.get(id);
  if (!p) return null;
  return p.history.slice(-limit).map((r) => ({
    t: r.receivedAt,
    voltage: r.voltage,
    current: r.current,
    power: r.power,
    soc: r.soc,
    cellMin: r.cellMin,
    cellMax: r.cellMax,
    spreadMv: r.spreadMv,
    maxTemp: r.moduleTemps.length ? Math.max(...r.moduleTemps.map((m) => m.value)) : null,
  }));
}

export function getStats(): StoreStats & { packs: number; uptimeS: number } {
  const store = getStore();
  return {
    ...store.stats,
    packs: store.packs.size,
    uptimeS: Math.round((Date.now() - store.stats.startedAt) / 1000),
  };
}
