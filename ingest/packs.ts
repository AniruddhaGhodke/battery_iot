/**
 * Which device_ids are accepted, and their database ids.
 *
 * The packs table is the allowlist. It is cached here and re-read every 30 s,
 * so packs enabled or disabled in the database (later: from the device page)
 * take effect without a restart.
 */

import type { Sql } from "postgres";

type Entry = { id: number; enabled: boolean; slug: string | null };

const REFRESH_MS = 30_000;
const UNKNOWN_MAX = 50;

export class PackRegistry {
  private byDevice = new Map<string, Entry>();
  private registering = new Map<string, Promise<Entry | null>>();
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
      { id: number; device_id: string; enabled: boolean; topic_slug: string | null }[]
    >`select id, device_id, enabled, topic_slug from packs`;
    this.byDevice = new Map(
      rows.map((r) => [r.device_id, { id: r.id, enabled: r.enabled, slug: r.topic_slug }]),
    );
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

  /** Database id and topic slug for an enabled pack, for addressing a command. */
  resolve(deviceId: string): { packId: number; slug: string | null } | null {
    const e = this.byDevice.get(deviceId);
    return e && e.enabled ? { packId: e.id, slug: e.slug } : null;
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
          const row: Entry = { id: r.id, enabled: r.enabled, slug: r.topic_slug };
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
