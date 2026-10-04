import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { dbHealth } from "@/lib/data";
import type { IngestStatus, Status } from "@/lib/ingest-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function ingestStatus(): Promise<{ ingest: IngestStatus | null; ingestError: string | null }> {
  try {
    const r = await fetch(`${config.ingestUrl}/status`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ingest: null, ingestError: `ingest answered HTTP ${r.status}` };
    return { ingest: (await r.json()) as IngestStatus, ingestError: null };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return { ingest: null, ingestError: cause ?? (e as Error).message };
  }
}

/** Broker link, message counters, database health - the first place to look when data stops. */
export async function GET() {
  const [ing, db] = await Promise.all([ingestStatus(), dbHealth()]);
  const body: Status = { ...ing, db, staleAfterS: config.staleAfterS };
  return NextResponse.json(body);
}
