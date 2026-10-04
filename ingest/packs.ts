/**
 * Which device_ids are accepted, and their database ids.
 *
 * The packs table is the allowlist. It is cached here and re-read every 30 s,
 * so packs enabled or disabled in the database (later: from the device page)
 * take effect without a restart.
 */

import type { Sql } from "postgres";

type Entry = { id: number; enabled: boolean };

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
    const rows = await this.sql<{ id: number; device_id: string; enabled: boolean }[]>`
      select id, device_id, enabled from packs`;
    this.byDevice = new Map(rows.map((r) => [r.device_id, { id: r.id, enabled: r.enabled }]));
  }

  get count() {
    return [...this.byDevice.values()].filter((e) => e.enabled).length;
  }

  /**
   * Database id for an accepted device, or null if it is not allowed.
   * Synchronous for known devices: this runs on every message.
   */
  lookup(deviceId: string): number | null | Promise<number | null> {
    const e = this.byDevice.get(deviceId);
    if (e) return e.enabled ? e.id : this.reject(deviceId);
    if (!this.autoRegister) return this.reject(deviceId);
    return this.register(deviceId).then((r) => (r ? r.id : null));
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

  private register(deviceId: string): Promise<Entry | null> {
    let p = this.registering.get(deviceId);
    if (!p) {
      p = this.sql<{ id: number; enabled: boolean }[]>`
          insert into packs (device_id) values (${deviceId})
          on conflict (device_id) do update set device_id = excluded.device_id
          returning id, enabled`
        .then(([row]) => {
          this.byDevice.set(deviceId, row);
          console.log(`[packs] registered ${deviceId}`);
          return row.enabled ? row : null;
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
