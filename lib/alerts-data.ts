/** Alert history for the dashboard. Read-only; ingest writes these tables. */

import type { Diagnosis } from "./diagnose";
import { sql } from "./db";

export type AlertRow = {
  id: number;
  ts: number;
  pack: string | null;
  condition: string;
  kind: "raised" | "cleared";
  headline: string;
  detail: string;
  sent: boolean;
  error: string | null;
  analysis: Diagnosis | null;
};

export type ActiveAlert = {
  key: string;
  pack: string | null;
  condition: string;
  since: number;
  notified: boolean;
};

const MAX_LIMIT = 200;

export async function listAlerts(limit = 50, pack?: string): Promise<AlertRow[]> {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 50), MAX_LIMIT);
  const rows = await sql<
    {
      id: string;
      ts: Date;
      pack: string | null;
      condition: string;
      kind: string;
      headline: string;
      detail: string;
      sent: boolean;
      error: string | null;
      analysis: Diagnosis | null;
    }[]
  >`
    select id, ts, pack, condition, kind, headline, detail, sent, error, analysis
    from alert_log
    ${pack ? sql`where pack = ${pack}` : sql``}
    order by ts desc, id desc
    limit ${n}`;
  return rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts.getTime(),
    pack: r.pack,
    condition: r.condition,
    kind: r.kind === "cleared" ? "cleared" : "raised",
    headline: r.headline,
    detail: r.detail,
    sent: r.sent,
    error: r.error,
    analysis: r.analysis,
  }));
}

export async function getAlert(id: number): Promise<AlertRow | null> {
  if (!Number.isFinite(id)) return null;
  const rows = await listAlertsById(id);
  return rows[0] ?? null;
}

async function listAlertsById(id: number): Promise<AlertRow[]> {
  const rows = await sql<
    {
      id: string;
      ts: Date;
      pack: string | null;
      condition: string;
      kind: string;
      headline: string;
      detail: string;
      sent: boolean;
      error: string | null;
      analysis: Diagnosis | null;
    }[]
  >`
    select id, ts, pack, condition, kind, headline, detail, sent, error, analysis
    from alert_log where id = ${id}`;
  return rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts.getTime(),
    pack: r.pack,
    condition: r.condition,
    kind: r.kind === "cleared" ? "cleared" : "raised",
    headline: r.headline,
    detail: r.detail,
    sent: r.sent,
    error: r.error,
    analysis: r.analysis,
  }));
}

/** Alerts raised right now, straight from the table ingest keeps. */
export async function activeAlerts(): Promise<ActiveAlert[]> {
  const rows = await sql<{ key: string; since: Date; notified: boolean }[]>`
    select key, since, notified from alert_active order by since`;
  return rows.map((r) => {
    const i = r.key.indexOf("|");
    const pack = r.key.slice(0, i);
    return {
      key: r.key,
      pack: pack === "system" ? null : pack,
      condition: r.key.slice(i + 1),
      since: r.since.getTime(),
      notified: r.notified,
    };
  });
}
