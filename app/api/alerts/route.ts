import { NextResponse } from "next/server";
import { activeAlerts, listAlerts } from "@/lib/alerts-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Alert history with the cause analysis, plus what is raised right now. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const pack = url.searchParams.get("pack") ?? undefined;
  try {
    const [log, active] = await Promise.all([listAlerts(limit, pack), activeAlerts()]);
    return NextResponse.json({ log, active });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
