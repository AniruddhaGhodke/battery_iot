import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { listConfigRequests } from "@/lib/config-data";
import { IMAGE_MAX_BYTES } from "@/lib/firmware";
import { listFirmwareImages, storeFirmwareImage, UploadError } from "@/lib/firmware-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Who is asking, from the proxy's basic auth rather than from the browser. */
function requester(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Basic ")) return "unknown";
  try {
    return atob(auth.slice(6)).split(":")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

/** The images on hand, and the recent rollouts. */
export async function GET() {
  try {
    const [images, requests] = await Promise.all([listFirmwareImages(20), listConfigRequests(20)]);
    return NextResponse.json({ images, requests: requests.filter((r) => r.kind === "ota") });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}

/**
 * Uploads a firmware image. Multipart rather than JSON because the file is
 * 1–2 MB of binary; it is read into memory, which is fine at that size and
 * avoids a half-written image on disk.
 */
export async function POST(req: Request) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > IMAGE_MAX_BYTES * 2) {
    return NextResponse.json({ error: "that file is far too large to be a firmware image" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected a multipart upload" }, { status: 400 });
  }

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no image was attached" }, { status: 400 });
  }
  const version = String(form.get("version") ?? "");
  const notes = String(form.get("notes") ?? "").trim();

  try {
    const { image, existed } = await storeFirmwareImage({
      bytes: new Uint8Array(await file.arrayBuffer()),
      version,
      originalName: file.name || null,
      notes: notes ? notes.slice(0, 500) : null,
      uploadedBy: requester(req),
    });
    return NextResponse.json({ image, existed }, { status: existed ? 200 : 201 });
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: `could not store the image in ${config.firmwareDir}: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
