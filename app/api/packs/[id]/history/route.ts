import { NextResponse } from "next/server";
import { getHistory } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_SPAN_MS = 10 * 366 * 86_400_000;

/** Accepts epoch ms or anything Date.parse understands (ISO 8601). */
function time(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /api/packs/:id/history?from=&to=
 * Chart points for any range, at most ~800 per request. Defaults to the last 24 h.
 * Short ranges come from raw readings, long ones from the hourly/daily roll-ups;
 * `source` and `bucketS` in the response say which.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const now = Date.now();
  const to = time(q.get("to"), now);
  const from = time(q.get("from"), (to ?? now) - 86_400_000);
  if (from === null || to === null) {
    return NextResponse.json({ error: "from/to must be epoch ms or ISO 8601" }, { status: 400 });
  }
  if (from >= to || to - from > MAX_SPAN_MS) {
    return NextResponse.json({ error: "need from < to, and at most 10 years apart" }, { status: 400 });
  }
  const history = await getHistory(id, from, to);
  if (!history) {
    return NextResponse.json({ error: `unknown pack ${id}` }, { status: 404 });
  }
  return NextResponse.json(history);
}
