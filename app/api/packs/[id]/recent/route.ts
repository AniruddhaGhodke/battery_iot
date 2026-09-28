import { NextResponse } from "next/server";
import { getRecent } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 360, 1), 5000);
  const rows = getRecent(id, limit);
  if (!rows) {
    return NextResponse.json({ error: `no data for ${id} since the server started` }, { status: 404 });
  }
  return NextResponse.json(rows);
}
