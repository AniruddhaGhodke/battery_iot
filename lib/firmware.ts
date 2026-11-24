/**
 * Firmware images and over-the-air updates: the rules both ends agree on.
 *
 * The gateway firmware checks every OTA command itself before it will touch
 * flash (src/otaService.cpp in BATTERY-DISPLAY-SHARE):
 *
 *   target_uid   must equal its own hardware UID, or the command is ignored
 *   version      1–31 characters of [A-Za-z0-9._-]
 *   url          must start with https:// and be at most 255 characters
 *   sha256       exactly 64 hexadecimal characters
 *
 * The limits below are those checks, written once so the dashboard refuses
 * what the device would refuse — and silently, because a command the firmware
 * rejects for a bad field is only logged on its console: nothing is published
 * back, so a bad command looks exactly like a device that is not listening.
 *
 * The image is verified twice: here, by hashing the upload, and again on the
 * device, which hashes what it actually wrote to flash and refuses to boot it
 * on a mismatch. The file name is its own SHA-256, so uploading the same
 * build twice cannot produce two entries that differ.
 */

/** Firmware's isSafeVersion: OTA_VERSION_MAX is 31. */
export const VERSION_MAX = 31;
export const VERSION_RE = /^[A-Za-z0-9._-]{1,31}$/;

/** Firmware's OTA_URL_MAX. */
export const URL_MAX = 255;

export const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * An ESP32 application image starts with 0xE9. Checked on upload so a
 * mis-picked file (the .elf, a .bin from another toolchain, a zip) is caught
 * here rather than by a pack that has already erased its spare partition.
 */
export const IMAGE_MAGIC = 0xe9;

/** The dual-OTA partition table gives each app slot 1.9 MB. */
export const IMAGE_MAX_BYTES = 1_966_080;
/** Anything smaller than this is not a firmware image. */
export const IMAGE_MIN_BYTES = 64 * 1024;

export type FirmwareImage = {
  id: number;
  version: string;
  sha256: string;
  bytes: number;
  originalName: string | null;
  notes: string | null;
  uploadedBy: string;
  uploadedAt: number;
};

/** What the device fetches. The name is the hash, so it is content-addressed. */
export function firmwareFileName(sha256: string): string {
  return `${sha256}.bin`;
}

export function firmwareUrl(baseUrl: string, sha256: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/firmware/${firmwareFileName(sha256)}`;
}

/** Null when this version string is one the firmware will accept. */
export function versionError(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return "a version is required";
  const s = v.trim();
  if (s.length > VERSION_MAX) return `version must be at most ${VERSION_MAX} characters`;
  if (!VERSION_RE.test(s)) return "version may use letters, digits, dot, underscore and hyphen only";
  return null;
}

/** Null when this URL is one the firmware will fetch. */
export function urlError(u: string): string | null {
  if (!u.startsWith("https://")) {
    return `firmware URL must be HTTPS (got ${u.split(":")[0]}://…) — the device refuses anything else`;
  }
  if (u.length > URL_MAX) return `firmware URL is ${u.length} characters; the device accepts ${URL_MAX}`;
  return null;
}

/** Why this upload is not a firmware image, or null. */
export function imageError(bytes: Uint8Array): string | null {
  if (bytes.length < IMAGE_MIN_BYTES) {
    return `only ${bytes.length.toLocaleString("en-IN")} bytes — too small to be a firmware image`;
  }
  if (bytes.length > IMAGE_MAX_BYTES) {
    return `${bytes.length.toLocaleString("en-IN")} bytes will not fit the 1.9 MB OTA partition`;
  }
  if (bytes[0] !== IMAGE_MAGIC) {
    return `this does not look like an ESP32 image: it starts with 0x${bytes[0].toString(16).padStart(2, "0")}, not 0xe9. Upload firmware.bin from .pio/build, not the .elf`;
  }
  return null;
}

/** What the device reports on its status topic. */
export type OtaPhase = "downloading" | "installed" | "failed" | "rejected";

export type ParsedOtaStatus = {
  deviceUid: string | null;
  phase: OtaPhase | null;
  version: string | null;
  /** The version it is running now — the old one until it restarts. */
  currentVersion: string | null;
  message: string | null;
};

const PHASES: Record<string, OtaPhase> = {
  downloading: "downloading",
  installing: "downloading",
  installed: "installed",
  installed_ok: "installed",
  success: "installed",
  failed: "failed",
  error: "failed",
  rejected: "rejected",
};

/**
 * Reads an OTA status message. The shape is publishOtaStatus in the firmware:
 * `{device_uid, status, version, message, current_version}`. Lenient about
 * the wording of `status` for the same reason parseAck is.
 */
export function parseOtaStatus(doc: unknown): ParsedOtaStatus {
  const out: ParsedOtaStatus = {
    deviceUid: null,
    phase: null,
    version: null,
    currentVersion: null,
    message: null,
  };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  const d = doc as Record<string, unknown>;

  const uid = d.device_uid ?? d.deviceUid;
  if (typeof uid === "string" && /^[0-9A-Fa-f]{12}$/.test(uid.trim())) {
    out.deviceUid = uid.trim().toUpperCase();
  }

  const raw = d.status ?? d.state ?? d.phase;
  if (typeof raw === "string") out.phase = PHASES[raw.trim().toLowerCase()] ?? null;

  const v = d.version;
  if (typeof v === "string" && v.trim()) out.version = v.trim().slice(0, VERSION_MAX);

  const cv = d.current_version ?? d.currentVersion;
  if (typeof cv === "string" && cv.trim()) out.currentVersion = cv.trim().slice(0, VERSION_MAX);

  const m = d.message ?? d.error ?? d.reason;
  if (typeof m === "string" && m.trim()) out.message = m.trim().slice(0, 500);

  return out;
}

/** What an OTA request asked for, as stored in config_requests.requested. */
export type OtaRequested = { version: string; sha256: string; url: string; firmware_id: number };

export function isOtaRequested(v: unknown): v is OtaRequested {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return typeof d.version === "string" && typeof d.sha256 === "string";
}
