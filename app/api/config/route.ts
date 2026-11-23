import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { listConfigRequests, listConfigurablePacks } from "@/lib/config-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Packs that can be configured, and the recent request history. */
export async function GET(req: Request) {
  const device = new URL(req.url).searchParams.get("device") ?? undefined;
  try {
    const [packs, requests] = await Promise.all([
      listConfigurablePacks(),
      listConfigRequests(20, device),
    ]);
    return NextResponse.json({ packs, requests });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}

/**
 * Hands a configuration request to ingest, which owns the broker connection.
 * The browser never holds MQTT credentials, so this proxy is the only route
 * from the dashboard to a device.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  // Identity comes from the proxy's basic auth, not from the browser: a
  // client-supplied name would be worthless in an audit trail.
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
    const res = await fetch(`${config.ingestUrl}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: b.device_id,
        settings: b.settings,
        requested_by: requestedBy,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: `cannot reach ingest: ${(e as Error).message}` },
      { status: 503 },
    );
  }
}
