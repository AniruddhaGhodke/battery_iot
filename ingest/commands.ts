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
 *
 * Firmware updates go the same way on their own pair of topics, with one more
 * step — sent → downloading → restarting → applied — and a stricter finish:
 * the pack must come back reporting the version we sent. A board that boots
 * the new image, fails its own health check and rolls itself back comes up on
 * the old version, which looks identical to a successful update from the
 * outside. Checking the version is what tells the two apart.
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
import {
  type FirmwareImage,
  firmwareUrl,
  parseOtaStatus,
  urlError,
  versionError,
} from "../lib/firmware.ts";
import {
  type ControlAction,
  type ControlValue,
  interlockError,
  type LatestReading,
  validateControl,
} from "../lib/pack-control.ts";

export type ConfigRequest = {
  id: number;
  deviceId: string;
  packId: number;
  /** A setting change, switching the channel, or a firmware update. */
  kind: "config" | "control" | "ota";
  settings: ConfigSettings;
  /** OTA only: the image being installed, and the version to expect back. */
  firmware: { id: number; version: string; sha256: string } | null;
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
  /** Templates for the control topics, kept apart from configuration. */
  controlSetTopic: string;
  controlAckTopic: string;
  /** A control command the firmware receives after this must be ignored. */
  controlExpiryMs: number;
  /** Refuse to open the channel above this current. */
  controlMaxCurrentA: number;
  /** Firmware updates (lib/firmware.ts). */
  otaCommandTopic: string;
  otaStatusTopic: string;
  /** Public HTTPS base the device downloads the image from. */
  firmwareBaseUrl: string;
  /** How long the download itself may take before we give up on it. */
  otaDownloadTimeoutMs: number;
  /** After "installed", how long the reboot and reconnect may take. */
  otaRestartGraceMs: number;
};

/** What the manager needs from the rest of ingest. */
export type CommandDeps = {
  /** What is needed to address a device, or null if it cannot be addressed. */
  resolve: (deviceId: string) => { packId: number; slug: string | null; uid: string | null } | null;
  /** Tells the alert engine not to call this pack offline while it restarts. */
  expectSilence: (deviceId: string, untilMs: number) => void;
  /** The pack's last reading, for the control interlock. */
  latest: (deviceId: string) => LatestReading | null;
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

  /**
   * The checks every command shares: the pack exists, we know where to send
   * to, we know which board to address, and nothing else is in flight for it.
   */
  private address(deviceId: string): { packId: number; slug: string; uid: string } {
    const target = this.deps.resolve(deviceId);
    if (!target) throw new ConfigError(`unknown or disabled pack: ${deviceId}`, 404);
    if (!target.slug) {
      throw new ConfigError(
        `no topic known for ${deviceId} yet — it is recorded the first time the pack publishes telemetry`,
        409,
      );
    }
    if (!target.uid) {
      throw new ConfigError(
        `no hardware UID known for ${deviceId}. Commands name their target by UID (target_uid) because every pack shares one topic, so without it the device ignores them. The UID arrives with the first reading from firmware that reports one.`,
        409,
      );
    }
    for (const r of this.open.values()) {
      if (r.deviceId === deviceId) {
        throw new ConfigError(`request ${r.id} for ${deviceId} is still waiting for the device`, 409);
      }
    }
    return { packId: target.packId, slug: target.slug, uid: target.uid };
  }

  /**
   * Starts a firmware update. The image is not sent over MQTT: the device is
   * told where to fetch it and what it must hash to, and pulls it itself.
   */
  async submitOta(deviceId: string, image: FirmwareImage, requestedBy: string): Promise<ConfigRequest> {
    const bad = versionError(image.version);
    if (bad) throw new ConfigError(bad, 400);
    if (!this.opts.firmwareBaseUrl) {
      throw new ConfigError(
        "no firmware URL is configured: set SITE_ADDRESS (or FIRMWARE_BASE_URL) on the ingest service so the device can be told where to download from",
        503,
      );
    }
    const url = firmwareUrl(this.opts.firmwareBaseUrl, image.sha256);
    const badUrl = urlError(url);
    if (badUrl) throw new ConfigError(badUrl, 400);

    const target = this.address(deviceId);

    const now = Date.now();
    const requested = {
      version: image.version,
      sha256: image.sha256,
      url,
      firmware_id: image.id,
    };
    const rows = await this.sql<{ id: string }[]>`
      insert into config_requests ${this.sql({
        pack_id: target.packId,
        device_id: deviceId,
        kind: "ota",
        firmware_id: image.id,
        requested: this.sql.json(requested as never),
        status: "pending",
        requested_by: requestedBy,
        requested_at: new Date(now),
      })} returning id`;
    const id = Number(rows[0].id);

    const req: ConfigRequest = {
      id,
      deviceId,
      packId: target.packId,
      kind: "ota",
      settings: {},
      firmware: { id: image.id, version: image.version, sha256: image.sha256 },
      status: "pending",
      // It stops publishing while it downloads, then restarts.
      restarts: true,
      requestedAt: now,
      sentAt: null,
      ackedAt: null,
      ack: null,
      error: null,
    };
    this.open.set(id, req);
    this.stats.submitted++;

    // The download blocks the firmware's main loop and the reboot follows, so
    // the pack goes quiet for minutes. Told in advance, the alert engine will
    // not report it offline (ingest/alerts.ts, expectSilence).
    this.deps.expectSilence(deviceId, now + this.opts.otaDownloadTimeoutMs + this.opts.otaRestartGraceMs);

    const topic = topicFor(this.opts.otaCommandTopic, target.slug);
    const payload = JSON.stringify({
      target_uid: target.uid,
      version: image.version,
      url,
      sha256: image.sha256,
    });
    this.client.publish(topic, payload, { qos: 1, retain: false }, (err) => {
      if (err) void this.finish(id, "failed", `publish failed: ${err.message}`);
      else void this.markSent(id);
    });
    console.log(`[ota] #${id} ${deviceId} -> ${topic} ${payload}`);
    return req;
  }

  /**
   * A message on an OTA status topic. There is no request id in it — the
   * firmware does not echo one — so it is matched on the device UID it
   * reports, falling back to the topic it arrived on.
   */
  handleOtaStatus(topic: string, doc: unknown) {
    const s = parseOtaStatus(doc);
    const open = [...this.open.values()].filter((r) => r.kind === "ota" && !isFinal(r.status));
    let req = s.deviceUid
      ? (open.find((r) => this.deps.resolve(r.deviceId)?.uid === s.deviceUid) ?? null)
      : null;
    if (!req) req = open.find((r) => this.topicMatches(r, topic)) ?? null;
    if (!req) {
      console.warn(`[ota] unmatched status on ${topic}: ${JSON.stringify(doc).slice(0, 200)}`);
      return;
    }
    req.ack = doc;

    if (s.phase === "failed" || s.phase === "rejected") {
      // It is not going to restart after all, so stop holding off the
      // offline alert — if the pack is now dead we want to hear about it.
      this.deps.expectSilence(req.deviceId, Date.now() + 60_000);
      void this.finish(
        req.id,
        "rejected",
        s.message ?? `the device ${s.phase} the update`,
        doc,
      );
      return;
    }
    if (s.phase === "downloading") {
      if (req.status === "downloading") return;
      req.status = "downloading";
      void this.persist(req.id, { status: "downloading", ack: this.sql.json(doc as never) }, [
        "pending",
        "sent",
      ]);
      console.log(`[ota] #${req.id} ${req.deviceId} downloading ${s.version ?? ""}`.trimEnd());
      return;
    }
    if (s.phase === "installed") {
      req.status = "restarting";
      req.ackedAt = Date.now();
      void this.persist(
        req.id,
        {
          status: "restarting",
          acked_at: new Date(req.ackedAt),
          ack: this.sql.json(doc as never),
        },
        ["pending", "sent", "downloading"],
      );
      console.log(`[ota] #${req.id} ${req.deviceId} flashed, waiting for it to come back`);
      return;
    }
    console.warn(`[ota] #${req.id} ${req.deviceId} status not understood: ${JSON.stringify(doc).slice(0, 200)}`);
  }

  /** Validates, records and publishes. Throws ConfigError for a bad request. */
  async submit(deviceId: string, rawSettings: unknown, requestedBy: string): Promise<ConfigRequest> {
    const v = validateSettings(rawSettings);
    if (!v.ok) throw new ConfigError("invalid settings", 400, v.errors);

    const target = this.address(deviceId);

    const now = Date.now();
    const rows = await this.sql<{ id: string }[]>`
      insert into config_requests ${this.sql({
        pack_id: target.packId,
        device_id: deviceId,
        kind: "config",
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
      kind: "config",
      settings: v.settings,
      firmware: null,
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
    // target_uid is what makes a shared topic safe: every board checks it and
    // only the addressed one acts (firmware: commandTargetsThisDevice).
    const body = JSON.stringify({ target_uid: target.uid, ...v.settings });
    // Not retained: a retained configuration would be redelivered on every
    // reconnect and reapplied, which is the wrong behaviour for a command.
    this.client.publish(topic, body, { qos: 1, retain: false }, (err) => {
      if (err) void this.finish(id, "failed", `publish failed: ${err.message}`);
      else void this.markSent(id);
    });
    console.log(`[config] #${id} ${deviceId} -> ${topic} ${body}`);
    return req;
  }

  /**
   * Switches the pack's channel. Separate from submit() because it carries an
   * expiry, is checked against live telemetry first, and goes out on its own
   * topic (lib/pack-control.ts).
   */
  async submitControl(
    deviceId: string,
    action: unknown,
    value: unknown,
    requestedBy: string,
  ): Promise<ConfigRequest> {
    const v = validateControl(action, value);
    if (!v.ok) throw new ConfigError(v.error, 400);

    const target = this.address(deviceId);

    // Checked here, on the server, against what the pack last reported — not
    // in the browser, which can be stale or bypassed.
    const blocked = interlockError(v.value, this.deps.latest(deviceId), this.opts.controlMaxCurrentA);
    if (blocked) throw new ConfigError(blocked, 409);

    const now = Date.now();
    const expiresAt = now + this.opts.controlExpiryMs;
    const requested = { action: v.spec.action, value: v.value };
    const rows = await this.sql<{ id: string }[]>`
      insert into config_requests ${this.sql({
        pack_id: target.packId,
        device_id: deviceId,
        kind: "control",
        requested: this.sql.json(requested as never),
        status: "pending",
        requested_by: requestedBy,
        requested_at: new Date(now),
        expires_at: new Date(expiresAt),
      })} returning id`;
    const id = Number(rows[0].id);

    const req: ConfigRequest = {
      id,
      deviceId,
      packId: target.packId,
      kind: "control",
      settings: {},
      firmware: null,
      status: "pending",
      restarts: false,
      requestedAt: now,
      sentAt: null,
      ackedAt: null,
      ack: null,
      error: null,
    };
    this.open.set(id, req);
    this.stats.submitted++;

    const topic = topicFor(this.opts.controlSetTopic, target.slug);
    const payload = JSON.stringify({
      target_uid: target.uid,
      ...requested,
      request_id: id,
      expires_at: expiresAt,
    });
    this.client.publish(topic, payload, { qos: 1, retain: false }, (err) => {
      if (err) void this.finish(id, "failed", `publish failed: ${err.message}`);
      else void this.markSent(id);
    });
    console.log(`[control] #${id} ${deviceId} -> ${topic} ${payload}`);
    return req;
  }

  private async markSent(id: number) {
    const req = this.open.get(id);
    if (!req || req.status !== "pending") return;
    req.status = "sent";
    req.sentAt = Date.now();
    this.stats.sent++;
    await this.persist(id, { status: "sent", sent_at: new Date(req.sentAt) }, ["pending"]);
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
      void this.persist(
        req.id,
        {
          status: "restarting",
          acked_at: new Date(req.ackedAt),
          ack: this.sql.json(doc as never),
        },
        ["pending", "sent"],
      );
      console.log(`[config] #${req.id} ${req.deviceId} acknowledged, waiting for it to come back`);
    } else {
      void this.finish(req.id, "applied", ack.error, doc);
    }
  }

  /**
   * A reading arrived: a restarting pack is back. For a firmware update the
   * version it reports decides the outcome — a board that rolled itself back
   * is publishing again, but is not running what we sent.
   */
  onTelemetry(deviceId: string, firmwareVersion?: string | null) {
    for (const r of this.open.values()) {
      if (r.deviceId !== deviceId || r.status !== "restarting") continue;
      if (r.kind === "ota" && r.firmware) {
        if (!firmwareVersion) {
          // Nothing to compare against yet; wait for the grace period rather
          // than calling an update applied on no evidence.
          continue;
        }
        if (firmwareVersion !== r.firmware.version) {
          this.deps.expectSilence(deviceId, Date.now() + 60_000);
          void this.finish(
            r.id,
            "failed",
            `the pack came back running ${firmwareVersion}, not ${r.firmware.version} — the image was rejected on boot and it rolled back`,
            r.ack,
          );
          continue;
        }
        this.deps.expectSilence(deviceId, Date.now());
        void this.finish(r.id, "applied", null, r.ack);
        console.log(`[ota] #${r.id} ${deviceId} running ${firmwareVersion}`);
        continue;
      }
      void this.finish(r.id, "applied", null, r.ack);
      console.log(`[config] #${r.id} ${deviceId} telemetry resumed`);
    }
  }

  /** Gives up on requests the device never answered. */
  tick(now = Date.now()) {
    for (const r of this.open.values()) {
      const ota = r.kind === "ota";
      if (r.status === "pending" || r.status === "sent") {
        // An OTA command the firmware rejects for a malformed field is only
        // written to its console — nothing comes back on MQTT — so a silent
        // timeout is the normal way a bad command ends. Say so.
        if (now - r.requestedAt >= this.opts.ackTimeoutMs) {
          void this.finish(
            r.id,
            "timeout",
            ota
              ? "the device never acknowledged the update. It was either not listening, or it refused the command without reporting why — check its console"
              : "no acknowledgement from the device",
          );
        }
      } else if (r.status === "downloading") {
        if (now - r.requestedAt >= this.opts.otaDownloadTimeoutMs) {
          this.deps.expectSilence(r.deviceId, now + 60_000);
          void this.finish(r.id, "timeout", "the download did not finish in time", r.ack);
        }
      } else if (r.status === "restarting" && r.ackedAt !== null) {
        const grace = ota ? this.opts.otaRestartGraceMs : this.opts.restartGraceMs;
        if (now - r.ackedAt >= grace) {
          this.deps.expectSilence(r.deviceId, now + 60_000);
          void this.finish(
            r.id,
            "timeout",
            ota
              ? "flashed, but the pack has not published since — it may be stuck on the new image, and should roll itself back"
              : "acknowledged, but telemetry did not resume",
            r.ack,
          );
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
    // No request id in the payload: fall back to the device by name, then to
    // the topic it answered on, and take its oldest outstanding request. The
    // topic fallback matters for a rename: the device acknowledges under its
    // new name, which is not the name the request was sent to.
    const open = [...this.open.values()].filter((r) => r.kind !== "ota" && !isFinal(r.status));
    let candidates = ack.deviceId ? open.filter((r) => r.deviceId === ack.deviceId) : [];
    if (!candidates.length) candidates = open.filter((r) => this.topicMatches(r, topic));
    candidates.sort((a, b) => a.requestedAt - b.requestedAt);
    return candidates[0] ?? null;
  }

  private topicMatches(r: ConfigRequest, topic: string): boolean {
    const target = this.deps.resolve(r.deviceId);
    if (!target?.slug) return false;
    const template =
      r.kind === "control"
        ? this.opts.controlAckTopic
        : r.kind === "ota"
          ? this.opts.otaStatusTopic
          : this.opts.ackTopic;
    return topicFor(template, target.slug) === topic;
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
    const interval = req.settings.telemetry_interval_ms;
    if (status === "applied" && typeof interval === "number") {
      try {
        await this.sql`
          update packs set telemetry_interval_ms = ${interval}
           where id = ${req.packId}`;
      } catch (e) {
        console.warn(`[config] could not record the interval: ${(e as Error).message}`);
      }
    }
    const tag = req.kind === "ota" ? "ota" : req.kind === "control" ? "control" : "config";
    console.log(`[${tag}] #${id} ${req.deviceId} ${status}${req.error ? `: ${req.error}` : ""}`);
  }

  /**
   * Writes a request's new state.
   *
   * `allowed` makes a step monotonic: it only moves the row forward from one
   * of those statuses. Two updates for the same request can be in flight at
   * once — a device on the same network can answer before the "sent" write
   * has landed — and the pool gives no ordering between connections, so
   * without this a late "sent" could overwrite "applied" and the page would
   * show a finished request as still waiting. The final write has no guard:
   * the outcome always wins.
   */
  private async persist(id: number, fields: Record<string, unknown>, allowed?: RequestStatus[]) {
    try {
      if (allowed) {
        await this.sql`
          update config_requests set ${this.sql(fields)}
           where id = ${id} and status = any(${allowed})`;
      } else {
        await this.sql`update config_requests set ${this.sql(fields)} where id = ${id}`;
      }
    } catch (e) {
      console.warn(`[config] could not update request ${id}: ${(e as Error).message}`);
    }
  }
}

export const RESTART_GRACE_DEFAULT_MS = RESTART_GRACE_MS;
