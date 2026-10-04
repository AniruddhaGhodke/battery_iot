import { NextResponse } from "next/server";
import { getRecent } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The last `limit` raw readings (default 360, ~30 min at 5 s), for the live charts. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 360, 1), 5000);
  const rows = await getRecent(id, limit);
  if (!rows) {
    return NextResponse.json({ error: `unknown pack ${id}` }, { status: 404 });
  }
  return NextResponse.json(rows);
}
