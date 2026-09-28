import { NextResponse } from "next/server";
import { getStats } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Connection health and message counters - the first place to look when data stops. */
export function GET() {
  return NextResponse.json(getStats());
}
