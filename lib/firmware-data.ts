/** Firmware images: the store on disk and the rows that describe it. */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { sql } from "./db";
import { type FirmwareImage, firmwareFileName, imageError, versionError } from "./firmware";

/** Where an image lives. The name is its hash, so this is content-addressed. */
export function imagePath(sha256: string): string {
  return path.join(config.firmwareDir, firmwareFileName(sha256));
}

export async function listFirmwareImages(limit = 20): Promise<FirmwareImage[]> {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 20), 100);
  const rows = await sql<
    {
      id: string;
      version: string;
      sha256: string;
      bytes: string;
      originalName: string | null;
      notes: string | null;
      uploadedBy: string;
      uploadedAt: Date;
    }[]
  >`
    select id,
           version,
           sha256,
           bytes,
           original_name as "originalName",
           notes,
           uploaded_by   as "uploadedBy",
           uploaded_at   as "uploadedAt"
      from firmware_images
     order by uploaded_at desc, id desc
     limit ${n}`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    bytes: Number(r.bytes),
    uploadedAt: r.uploadedAt.getTime(),
  }));
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Stores an uploaded image and records it.
 *
 * The hash is computed here, from the bytes as received, and becomes both the
 * file name and what the device is told to expect — so the dashboard cannot
 * publish a hash that belongs to a different file than the one it is serving.
 * Written to a temporary name and renamed, so a failed upload cannot leave a
 * half-written image behind for a pack to download.
 *
 * Re-uploading the same build is not an error: the row already there is
 * returned, because two entries for identical bytes would only be confusing.
 */
export async function storeFirmwareImage(opts: {
  bytes: Uint8Array;
  version: string;
  originalName: string | null;
  notes: string | null;
  uploadedBy: string;
}): Promise<{ image: FirmwareImage; existed: boolean }> {
  const bad = versionError(opts.version);
  if (bad) throw new UploadError(bad);
  const version = opts.version.trim();

  const wrong = imageError(opts.bytes);
  if (wrong) throw new UploadError(wrong);

  const sha256 = createHash("sha256").update(opts.bytes).digest("hex");

  const existing = await sql<
    { id: string; version: string; bytes: string; originalName: string | null; notes: string | null; uploadedBy: string; uploadedAt: Date }[]
  >`
    select id, version, bytes, original_name as "originalName", notes,
           uploaded_by as "uploadedBy", uploaded_at as "uploadedAt"
      from firmware_images where sha256 = ${sha256}`;
  if (existing.length) {
    const r = existing[0];
    return {
      image: {
        ...r,
        id: Number(r.id),
        sha256,
        bytes: Number(r.bytes),
        uploadedAt: r.uploadedAt.getTime(),
      },
      existed: true,
    };
  }

  await fs.mkdir(config.firmwareDir, { recursive: true });
  const target = imagePath(sha256);
  const tmp = `${target}.${process.pid}.part`;
  try {
    await fs.writeFile(tmp, opts.bytes, { flag: "w" });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new UploadError(`could not store the image: ${(e as Error).message}`, 500);
  }

  const rows = await sql<{ id: string; uploadedAt: Date }[]>`
    insert into firmware_images ${sql({
      version,
      sha256,
      bytes: opts.bytes.length,
      original_name: opts.originalName,
      notes: opts.notes,
      uploaded_by: opts.uploadedBy,
    })} returning id, uploaded_at as "uploadedAt"`;

  return {
    image: {
      id: Number(rows[0].id),
      version,
      sha256,
      bytes: opts.bytes.length,
      originalName: opts.originalName,
      notes: opts.notes,
      uploadedBy: opts.uploadedBy,
      uploadedAt: rows[0].uploadedAt.getTime(),
    },
    existed: false,
  };
}
