import { NextResponse } from "next/server";
import { getPack } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pack = getPack(id);
  if (!pack) {
    return NextResponse.json({ error: `no data for ${id} since the server started` }, { status: 404 });
  }
  return NextResponse.json(pack);
}
