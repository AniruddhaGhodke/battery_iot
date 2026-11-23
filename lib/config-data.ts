/** Remote-configuration queries for the dashboard. Ingest does the writing. */

import { config } from "./config";
import { sql } from "./db";
import { type ConfigSettings, type RequestStatus, staleAfterMs } from "./pack-config";

export type ConfigurablePack = {
  deviceId: string;
  label: string | null;
  site: string | null;
  /** The topic segment it publishes on. Null until it has sent telemetry. */
  topicSlug: string | null;
  /** The interval we last set, if any. */
  telemetryIntervalMs: number | null;
  lastSeen: number | null;
  online: boolean;
};

/** What a control request asked for, as stored in `requested`. */
export type ControlRequested = { action: string; value: string };

export type ConfigRequestRow = {
  id: number;
  deviceId: string;
  kind: "config" | "control";
  requested: ConfigSettings | ControlRequested;
  status: RequestStatus;
  requestedBy: string;
  requestedAt: number;
  sentAt: number | null;
  ackedAt: number | null;
  ack: unknown;
  error: string | null;
};

export async function listConfigurablePacks(): Promise<ConfigurablePack[]> {
  const rows = await sql<
    {
      deviceId: string;
      label: string | null;
      site: string | null;
      topicSlug: string | null;
      telemetryIntervalMs: number | null;
      lastSeen: string | null;
    }[]
  >`
    select p.device_id                                        as "deviceId",
           p.label,
           p.site,
           p.topic_slug                                       as "topicSlug",
           p.telemetry_interval_ms                            as "telemetryIntervalMs",
           (extract(epoch from l.received_at) * 1000)::bigint::text as "lastSeen"
      from packs p
      left join pack_latest l on l.pack_id = p.id
     where p.enabled
     order by p.device_id`;
  const now = Date.now();
  return rows.map((r) => {
    const lastSeen = r.lastSeen === null ? null : Number(r.lastSeen);
    return {
      ...r,
      lastSeen,
      online:
        lastSeen !== null &&
        now - lastSeen < staleAfterMs(r.telemetryIntervalMs, config.staleAfterS * 1000),
    };
  });
}

export async function listConfigRequests(limit = 20, deviceId?: string): Promise<ConfigRequestRow[]> {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 20), 200);
  const rows = await sql<
    {
      id: string;
      deviceId: string;
      kind: string;
      requested: ConfigSettings | ControlRequested;
      status: string;
      requestedBy: string;
      requestedAt: Date;
      sentAt: Date | null;
      ackedAt: Date | null;
      ack: unknown;
      error: string | null;
    }[]
  >`
    select id,
           device_id    as "deviceId",
           kind,
           requested,
           status,
           requested_by as "requestedBy",
           requested_at as "requestedAt",
           sent_at      as "sentAt",
           acked_at     as "ackedAt",
           ack,
           error
      from config_requests
     ${deviceId ? sql`where device_id = ${deviceId}` : sql``}
     order by requested_at desc, id desc
     limit ${n}`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    kind: r.kind === "control" ? "control" : "config",
    status: r.status as RequestStatus,
    requestedAt: r.requestedAt.getTime(),
    sentAt: r.sentAt?.getTime() ?? null,
    ackedAt: r.ackedAt?.getTime() ?? null,
  }));
}
