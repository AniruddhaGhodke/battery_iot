import { NextResponse } from "next/server";
import { getPack } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pack = await getPack(id);
  if (!pack) {
    return NextResponse.json({ error: `no data for ${id}` }, { status: 404 });
  }
  return NextResponse.json(pack);
}
