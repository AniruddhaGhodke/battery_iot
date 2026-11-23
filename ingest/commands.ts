/**
 * Remote configuration: sends settings to a pack and tracks what came back.
 *
 *   dashboard ──HTTP──► ingest ──MQTT──► emspl/<id>/<slug>/config/set
 *                          ◄──MQTT───── emspl/<id>/<slug>/config/ack
 *
 * Ingest is the only process with broker credentials, so the browser never
 * holds them. Requests and outcomes live in config_requests.
 *
 * Status moves pending → sent → (restarting) → applied | rejected | timeout,
 * or straight to failed if the publish itself does not get through. A setting
 * that restarts the device is only "applied" once telemetry comes back, since
 * an acknowledgement alone does not prove the pack came up again.
 */

import type { Sql } from "postgres";
import type { MqttClient } from "mqtt";
import {
  type ConfigSettings,
  isFinal,
  RESTART_GRACE_MS,
  type RequestStatus,
  validateSettings,
} from "../lib/pack-config.ts";

export type ConfigRequest = {
  id: number;
  deviceId: string;
  packId: number;
  settings: ConfigSettings;
  status: RequestStatus;
  /** This setting restarts the device, so a silence is expected. */
  restarts: boolean;
  requestedAt: number;
  sentAt: number | null;
  ackedAt: number | null;
  ack: unknown;
  error: string | null;
};

export type CommandOptions = {
  /** Template with {slug}, e.g. emspl/a7f3c2/{slug}/config/set */
  setTopic: string;
  ackTopic: string;
  /** No acknowledgement within this and the request is given up on. */
  ackTimeoutMs: number;
  /** After an acknowledged restart, how long telemetry may take to return. */
  restartGraceMs: number;
};

/** What the manager needs from the rest of ingest. */
export type CommandDeps = {
  /** Database id and topic slug for a device, or null if it cannot be addressed. */
  resolve: (deviceId: string) => { packId: number; slug: string | null } | null;
  /** Tells the alert engine not to call this pack offline while it restarts. */
  expectSilence: (deviceId: string, untilMs: number) => void;
};

export class ConfigError extends Error {
  readonly status: number;
  readonly details: string[];
  constructor(message: string, status = 400, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Fills {slug} in a topic template. */
export function topicFor(template: string, slug: string): string {
  return template.replaceAll("{slug}", slug);
}

/** The template as a subscription pattern. */
export function subscriptionFor(template: string): string {
  return template.replaceAll("{slug}", "+");
}

export type ParsedAck = {
  deviceId: string | null;
  requestId: number | null;
  /** true accepted, false rejected, null the device did not say. */
  accepted: boolean | null;
  error: string | null;
};

const ACCEPTED = new Set(["accepted", "applied", "ok", "success", "done"]);
const REJECTED = new Set(["rejected", "failed", "error", "invalid", "refused"]);

/**
 * Reads an acknowledgement. Lenient on purpose: the firmware is not written
 * yet, so this accepts the shape in the README plus the obvious variants
 * rather than silently dropping an ack that says the right thing differently.
 */
export function parseAck(doc: unknown): ParsedAck {
  const out: ParsedAck = { deviceId: null, requestId: null, accepted: null, error: null };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  const d = doc as Record<string, unknown>;

  const id = d.device_id ?? d.deviceId;
  if (typeof id === "string" && id) out.deviceId = id;

  const rid = d.request_id ?? d.requestId;
  const ridNum = typeof rid === "string" ? Number(rid) : rid;
  if (typeof ridNum === "number" && Number.isInteger(ridNum) && ridNum > 0) out.requestId = ridNum;

  const raw = d.status ?? d.result ?? d.state;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (ACCEPTED.has(s)) out.accepted = true;
    else if (REJECTED.has(s)) out.accepted = false;
  }
  if (out.accepted === null) {
    const b = d.ok ?? d.accepted ?? d.success;
    if (typeof b === "boolean") out.accepted = b;
  }

  const err = d.error ?? d.message ?? d.reason;
  if (typeof err === "string" && err.trim()) out.error = err.trim().slice(0, 500);

  return out;
}

export class ConfigManager {
  private sql: Sql;
  private client: MqttClient;
  private opts: CommandOptions;
  private deps: CommandDeps;
  /** Requests still waiting on the device, by id. */
  private open = new Map<number, ConfigRequest>();

  readonly stats = { submitted: 0, sent: 0, applied: 0, rejected: 0, timedOut: 0, failed: 0 };

  constructor(sql: Sql, client: MqttClient, opts: CommandOptions, deps: CommandDeps) {
    this.sql = sql;
    this.client = client;
    this.opts = opts;
    this.deps = deps;
  }

  /**
   * Closes out anything left open by a previous process. Their in-flight
   * state is gone, so they cannot be matched to an acknowledgement any more.
   */
  async start() {
    try {
      const rows = await this.sql<{ id: string }[]>`
        update config_requests
           set status = 'timeout', error = 'ingest restarted before the device answered'
         where status in ('pending', 'sent', 'restarting')
        returning id`;
      if (rows.length) console.log(`[config] closed ${rows.length} request(s) left open by a restart`);
    } catch (e) {
      console.warn(`[config] could not close open requests: ${(e as Error).message}`);
    }
  }

  openRequests(): ConfigRequest[] {
    return [...this.open.values()];
  }

  /** Validates, records and publishes. Throws ConfigError for a bad request. */
  async submit(deviceId: string, rawSettings: unknown, requestedBy: string): Promise<ConfigRequest> {
    const v = validateSettings(rawSettings);
    if (!v.ok) throw new ConfigError("invalid settings", 400, v.errors);

    const target = this.deps.resolve(deviceId);
    if (!target) throw new ConfigError(`unknown or disabled pack: ${deviceId}`, 404);
    if (!target.slug) {
      throw new ConfigError(
        `no topic known for ${deviceId} yet — it is recorded the first time the pack publishes telemetry`,
        409,
      );
    }
    for (const r of this.open.values()) {
      if (r.deviceId === deviceId) {
        throw new ConfigError(`request ${r.id} for ${deviceId} is still waiting for the device`, 409);
      }
    }

    const now = Date.now();
    const rows = await this.sql<{ id: string }[]>`
      insert into config_requests ${this.sql({
        pack_id: target.packId,
        device_id: deviceId,
        requested: this.sql.json(v.settings as never),
        status: "pending",
        requested_by: requestedBy,
        requested_at: new Date(now),
      })} returning id`;
    const id = Number(rows[0].id);

    const req: ConfigRequest = {
      id,
      deviceId,
      packId: target.packId,
      settings: v.settings,
      status: "pending",
      restarts: v.restarts,
      requestedAt: now,
      sentAt: null,
      ackedAt: null,
      ack: null,
      error: null,
    };
    this.open.set(id, req);
    this.stats.submitted++;

    const topic = topicFor(this.opts.setTopic, target.slug);
    // Not retained: a retained configuration would be redelivered on every
    // reconnect and reapplied, which is the wrong behaviour for a command.
    this.client.publish(topic, JSON.stringify(v.settings), { qos: 1, retain: false }, (err) => {
      if (err) void this.finish(id, "failed", `publish failed: ${err.message}`);
      else void this.markSent(id);
    });
    console.log(`[config] #${id} ${deviceId} -> ${topic} ${JSON.stringify(v.settings)}`);
    return req;
  }

  private async markSent(id: number) {
    const req = this.open.get(id);
    if (!req || req.status !== "pending") return;
    req.status = "sent";
    req.sentAt = Date.now();
    this.stats.sent++;
    await this.persist(id, { status: "sent", sent_at: new Date(req.sentAt) });
  }

  /** An acknowledgement arrived on the ack topic. */
  handleAck(topic: string, doc: unknown) {
    const ack = parseAck(doc);
    const req = this.match(ack, topic);
    if (!req) {
      console.warn(`[config] unmatched acknowledgement on ${topic}: ${JSON.stringify(doc).slice(0, 200)}`);
      return;
    }
    req.ack = doc;
    req.ackedAt = Date.now();

    if (ack.accepted === false) {
      void this.finish(req.id, "rejected", ack.error ?? "the device rejected the settings", doc);
      return;
    }
    // Accepted, or the device did not say — treat silence as acceptance but
    // keep its payload, since rejecting on ambiguity would be worse.
    if (req.restarts) {
      req.status = "restarting";
      const until = Date.now() + this.opts.restartGraceMs;
      this.deps.expectSilence(req.deviceId, until);
      void this.persist(req.id, {
        status: "restarting",
        acked_at: new Date(req.ackedAt),
        ack: this.sql.json(doc as never),
      });
      console.log(`[config] #${req.id} ${req.deviceId} acknowledged, waiting for it to come back`);
    } else {
      void this.finish(req.id, "applied", ack.error, doc);
    }
  }

  /** A reading arrived: a restarting pack is back. */
  onTelemetry(deviceId: string) {
    for (const r of this.open.values()) {
      if (r.deviceId === deviceId && r.status === "restarting") {
        void this.finish(r.id, "applied", null, r.ack);
        console.log(`[config] #${r.id} ${deviceId} telemetry resumed`);
      }
    }
  }

  /** Gives up on requests the device never answered. */
  tick(now = Date.now()) {
    for (const r of this.open.values()) {
      if (r.status === "pending" || r.status === "sent") {
        if (now - r.requestedAt >= this.opts.ackTimeoutMs) {
          void this.finish(r.id, "timeout", "no acknowledgement from the device");
        }
      } else if (r.status === "restarting" && r.ackedAt !== null) {
        if (now - r.ackedAt >= this.opts.restartGraceMs) {
          void this.finish(r.id, "timeout", "acknowledged, but telemetry did not resume", r.ack);
        }
      }
    }
  }

  /** Matches an acknowledgement to an open request. */
  private match(ack: ParsedAck, topic: string): ConfigRequest | null {
    if (ack.requestId !== null) {
      const r = this.open.get(ack.requestId);
      return r && !isFinal(r.status) ? r : null;
    }
    // No request id in the payload: fall back to the device, by name or by
    // the topic it answered on, and take its oldest outstanding request.
    const candidates = [...this.open.values()]
      .filter((r) => r.status === "sent" || r.status === "restarting" || r.status === "pending")
      .filter((r) => (ack.deviceId ? r.deviceId === ack.deviceId : this.topicMatches(r, topic)));
    candidates.sort((a, b) => a.requestedAt - b.requestedAt);
    return candidates[0] ?? null;
  }

  private topicMatches(r: ConfigRequest, topic: string): boolean {
    const target = this.deps.resolve(r.deviceId);
    return target?.slug ? topicFor(this.opts.ackTopic, target.slug) === topic : false;
  }

  private async finish(id: number, status: RequestStatus, error?: string | null, ack?: unknown) {
    const req = this.open.get(id);
    if (!req) return;
    req.status = status;
    req.error = error ?? null;
    this.open.delete(id);
    if (status === "applied") this.stats.applied++;
    else if (status === "rejected") this.stats.rejected++;
    else if (status === "timeout") this.stats.timedOut++;
    else if (status === "failed") this.stats.failed++;

    const fields: Record<string, unknown> = { status, error: req.error };
    if (req.ackedAt !== null) fields.acked_at = new Date(req.ackedAt);
    if (ack !== undefined && ack !== null) fields.ack = this.sql.json(ack as never);
    await this.persist(id, fields);

    // Remember the interval we successfully set, so staleness and the offline
    // alert can follow it (lib/pack-config.ts).
    if (status === "applied" && req.settings.telemetry_interval_ms !== undefined) {
      try {
        await this.sql`
          update packs set telemetry_interval_ms = ${req.settings.telemetry_interval_ms}
           where id = ${req.packId}`;
      } catch (e) {
        console.warn(`[config] could not record the interval: ${(e as Error).message}`);
      }
    }
    console.log(`[config] #${id} ${req.deviceId} ${status}${req.error ? `: ${req.error}` : ""}`);
  }

  private async persist(id: number, fields: Record<string, unknown>) {
    try {
      await this.sql`update config_requests set ${this.sql(fields)} where id = ${id}`;
    } catch (e) {
      console.warn(`[config] could not update request ${id}: ${(e as Error).message}`);
    }
  }
}

export const RESTART_GRACE_DEFAULT_MS = RESTART_GRACE_MS;
