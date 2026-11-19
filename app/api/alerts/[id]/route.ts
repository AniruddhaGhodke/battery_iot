import { NextResponse } from "next/server";
import { getAlert } from "@/lib/alerts-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const alert = await getAlert(Number(id));
  if (!alert) return NextResponse.json({ error: `no alert ${id}` }, { status: 404 });
  return NextResponse.json(alert);
}
