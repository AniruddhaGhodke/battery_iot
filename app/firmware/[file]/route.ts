import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { SHA256_RE } from "@/lib/firmware";
import { imagePath } from "@/lib/firmware-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves a firmware image to a device.
 *
 * On the droplet, Caddy serves this path straight from the shared volume and
 * the request never reaches here — it has to, because the dashboard sits
 * behind basic auth and the ESP32 cannot send credentials. This route is the
 * same URL for `npm run dev`, and a fallback if that Caddy block is ever
 * removed.
 *
 * The only accepted name is "<64 hex>.bin": the hash of the image itself.
 * Nothing is listed, and a name that is not an exact hash is a 404, so this
 * cannot be walked or used to read anything else out of the directory.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const sha = file.endsWith(".bin") ? file.slice(0, -4) : "";
  if (!SHA256_RE.test(sha)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const bytes = await fs.readFile(imagePath(sha));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        // The name is the content's hash, so it can never change.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
