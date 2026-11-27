/**
 * Which device_ids are accepted, and their database ids.
 *
 * The packs table is the allowlist. It is cached here and re-read every 30 s,
 * so packs enabled or disabled in the database (later: from the device page)
 * take effect without a restart.
 */

import { type ReportedSetpoints, setpointsDiffer } from "../lib/bms-setpoints.ts";
import type { Sql } from "postgres";

type Entry = {
  id: number;
  enabled: boolean;
  slug: string | null;
  /** Hardware UID from the eFuse MAC, once the board has reported one. */
  uid: string | null;
};

const REFRESH_MS = 30_000;
const UNKNOWN_MAX = 50;

export class PackRegistry {
  private byDevice = new Map<string, Entry>();
  /** The same entries by hardware UID, which survives a device_id change. */
  private byUid = new Map<string, Entry>();
  private registering = new Map<string, Promise<Entry | null>>();
  /** Last firmware version written per pack, so we only write on a change. */
  private lastFirmware = new Map<number, string | null>();
  /** Last setpoints written per pack, so an unchanged set is not rewritten. */
  private lastSetpoints = new Map<number, ReportedSetpoints>();
  private timer: NodeJS.Timeout | null = null;
  /** Rejected device_ids, for /status. Capped so a flood can't grow it. */
  readonly unknown = new Map<string, { count: number; lastSeen: number }>();
  private sql: Sql;
  private autoRegister: boolean;

  // Plain fields, not parameter properties: Node runs this file with type
  // stripping only, which does not support them.
  constructor(sql: Sql, autoRegister: boolean) {
    this.sql = sql;
    this.autoRegister = autoRegister;
  }

  async start(seed: string[]) {
    if (seed.length) {
      await this.sql`
        insert into packs ${this.sql(seed.map((device_id) => ({ device_id })))}
        on conflict (device_id) do nothing`;
    }
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    const rows = await this.sql<
      {
        id: number;
        device_id: string;
        enabled: boolean;
        topic_slug: string | null;
        device_uid: string | null;
      }[]
    >`select id, device_id, enabled, topic_slug, device_uid from packs`;
    const byDevice = new Map<string, Entry>();
    const byUid = new Map<string, Entry>();
    for (const r of rows) {
      const e: Entry = { id: r.id, enabled: r.enabled, slug: r.topic_slug, uid: r.device_uid };
      byDevice.set(r.device_id, e);
      if (r.device_uid) byUid.set(r.device_uid, e);
    }
    this.byDevice = byDevice;
    this.byUid = byUid;
  }

  /**
   * Resolves a pack from what the payload claims. The hardware UID wins: a
   * board whose device_id was changed remotely is the same pack, and must not
   * become a second one with no history.
   *
   * Synchronous — this runs on every message. A rename is written back in the
   * background by noteIdentity().
   */
  lookupByIdentity(deviceId: string, uid: string | null): number | null | undefined {
    if (uid) {
      const byUid = this.byUid.get(uid);
      if (byUid) return byUid.enabled ? byUid.id : this.reject(deviceId);
    }
    return this.lookup(deviceId);
  }

  /**
   * Records the hardware UID, firmware version and clock state, and follows a
   * device_id change through to the packs table.
   */
  noteIdentity(deviceId: string, uid: string | null, firmware: string | null, timeSynced: boolean) {
    if (!uid) return;
    const known = this.byUid.get(uid);
    const byDevice = this.byDevice.get(deviceId);

    // A board we already know by UID now calls itself something else. Only
    // when the new name is free: if another pack row already holds it (two
    // boards that shipped with the same device_id, say) the rename would
    // collide on the unique index, and the UID has already sent this board's
    // readings to the right pack anyway.
    if (known && !byDevice) {
      const previous = [...this.byDevice.entries()].find(([, e]) => e === known)?.[0];
      this.byDevice.delete(previous ?? "");
      this.byDevice.set(deviceId, known);
      this.sql`update packs set device_id = ${deviceId} where id = ${known.id}`
        .then(() => console.log(`[packs] ${previous} renamed itself to ${deviceId} (uid ${uid})`))
        .catch((e) => console.warn(`[packs] rename failed: ${(e as Error).message}`));
    }

    const entry = known ?? byDevice;
    if (!entry) return;
    if (entry.uid === uid && this.lastFirmware.get(entry.id) === firmware) return;

    const firstTime = entry.uid !== uid;
    entry.uid = uid;
    this.byUid.set(uid, entry);
    this.lastFirmware.set(entry.id, firmware);
    this.sql`
      update packs
         set device_uid = ${uid}, firmware_version = ${firmware}, time_synced = ${timeSynced}
       where id = ${entry.id}`
      .then(() => {
        if (firstTime) console.log(`[packs] ${deviceId} has hardware uid ${uid}`);
      })
      .catch((e) => console.warn(`[packs] could not record identity: ${(e as Error).message}`));
  }

  /**
   * Records the limits the BMS reports for itself. Written only when they
   * change: they are configuration, not telemetry, and arrive with every
   * reading. See lib/bms-setpoints.ts for why they are stored unscaled.
   */
  noteSetpoints(deviceId: string, setpoints: ReportedSetpoints | null) {
    if (!setpoints) return;
    const e = this.byDevice.get(deviceId);
    if (!e) return;
    const last = this.lastSetpoints.get(e.id) ?? null;
    if (!setpointsDiffer(last, setpoints)) return;
    this.lastSetpoints.set(e.id, setpoints);
    this.sql`
      update packs
         set bms_setpoints = ${this.sql.json(setpoints as never)}, bms_setpoints_at = now()
       where id = ${e.id}`
      .then(() => console.log(`[packs] ${deviceId} reports setpoints ${JSON.stringify(setpoints)}`))
      .catch((err) => {
        this.lastSetpoints.delete(e.id); // try again on the next reading
        console.warn(`[packs] could not record setpoints for ${deviceId}: ${(err as Error).message}`);
      });
  }

  /**
   * Records which topic segment a pack publishes under, so configuration can
   * be addressed to it. Learned from the telemetry topic rather than
   * configured by hand, and only written when it changes.
   */
  noteTopic(deviceId: string, slug: string) {
    const e = this.byDevice.get(deviceId);
    if (!e || e.slug === slug) return;
    e.slug = slug;
    this.sql`update packs set topic_slug = ${slug} where id = ${e.id}`
      .then(() => console.log(`[packs] ${deviceId} publishes on "${slug}"`))
      .catch((err) => {
        e.slug = null; // try again on the next reading
        console.warn(`[packs] could not record the topic for ${deviceId}: ${(err as Error).message}`);
      });
  }

  /**
   * What is needed to address a command: the database id, the topic segment,
   * and the hardware UID the firmware checks against target_uid.
   */
  resolve(deviceId: string): { packId: number; slug: string | null; uid: string | null } | null {
    const e = this.byDevice.get(deviceId);
    return e && e.enabled ? { packId: e.id, slug: e.slug, uid: e.uid } : null;
  }

  /** device_ids of enabled packs (the alert engine watches these for silence). */
  enabledDevices(): string[] {
    return [...this.byDevice].filter(([, e]) => e.enabled).map(([d]) => d);
  }

  get count() {
    return [...this.byDevice.values()].filter((e) => e.enabled).length;
  }

  /**
   * Database id for an accepted device, null if it is not allowed, or
   * undefined for a new device that may be registered (auto-register on).
   * The caller registers it only once its payload is valid, so garbage
   * does not create packs. Synchronous: this runs on every message.
   */
  lookup(deviceId: string): number | null | undefined {
    const e = this.byDevice.get(deviceId);
    if (e) return e.enabled ? e.id : this.reject(deviceId);
    if (!this.autoRegister) return this.reject(deviceId);
    return undefined;
  }

  /** Adds a new device to the packs table. Its database id, or null if disabled or failed. */
  register(deviceId: string): Promise<number | null> {
    return this.insert(deviceId).then((r) => (r?.enabled ? r.id : null));
  }

  private reject(deviceId: string): null {
    const u = this.unknown.get(deviceId);
    if (u) {
      u.count++;
      u.lastSeen = Date.now();
    } else if (this.unknown.size < UNKNOWN_MAX) {
      this.unknown.set(deviceId, { count: 1, lastSeen: Date.now() });
    }
    return null;
  }

  private insert(deviceId: string): Promise<Entry | null> {
    let p = this.registering.get(deviceId);
    if (!p) {
      p = this.sql<{ id: number; enabled: boolean; topic_slug: string | null }[]>`
          insert into packs (device_id) values (${deviceId})
          on conflict (device_id) do update set device_id = excluded.device_id
          returning id, enabled, topic_slug`
        .then(([r]) => {
          const row: Entry = { id: r.id, enabled: r.enabled, slug: r.topic_slug, uid: null };
          this.byDevice.set(deviceId, row);
          console.log(`[packs] registered ${deviceId}`);
          return row;
        })
        .catch((e) => {
          console.warn(`[packs] could not register ${deviceId}: ${(e as Error).message}`);
          return null;
        })
        .finally(() => this.registering.delete(deviceId));
      this.registering.set(deviceId, p);
    }
    return p;
  }
}
