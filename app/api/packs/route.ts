import { NextResponse } from "next/server";
import { listPacks } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(listPacks());
}
