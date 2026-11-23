import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Switching a pack's channel. A separate route from /api/config so that the
 * two can be given different access later without untangling them, and so the
 * audit trail distinguishes a setpoint change from opening a contactor.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const auth = req.headers.get("authorization") ?? "";
  let requestedBy = "unknown";
  if (auth.startsWith("Basic ")) {
    try {
      const user = atob(auth.slice(6)).split(":")[0];
      if (user) requestedBy = user;
    } catch {
      // malformed header: leave it as unknown
    }
  }

  try {
    const res = await fetch(`${config.ingestUrl}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: b.device_id,
        action: b.action,
        value: b.value,
        requested_by: requestedBy,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: `cannot reach ingest: ${(e as Error).message}` }, { status: 503 });
  }
}
