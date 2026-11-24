import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Starts a firmware update. Like /api/config and /api/control this only hands
 * the request to ingest, which owns the broker connection; the browser says
 * which pack and which uploaded image, and nothing else. The version, hash
 * and URL are read from the database by ingest, so a rollout can only install
 * a file the server actually holds.
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
    const res = await fetch(`${config.ingestUrl}/ota`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: b.device_id,
        firmware_id: b.firmware_id,
        requested_by: requestedBy,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: `cannot reach ingest: ${(e as Error).message}` }, { status: 503 });
  }
}
