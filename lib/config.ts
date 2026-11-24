/** Web server configuration, read once from the environment. */

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgres://bms:bms_local@localhost:5433/bms",
  // ingest's internal status endpoint (MQTT link, counters).
  ingestUrl: process.env.INGEST_URL || "http://localhost:3101",
  staleAfterS: int(process.env.STALE_AFTER_S, 60),
  // Must match the retention policy in db/migrations (raw rows older than
  // this are gone; history falls back to the roll-ups).
  rawRetentionDays: int(process.env.RAW_RETENTION_DAYS, 90),
  // Where uploaded firmware images are kept. A Docker volume shared with
  // Caddy, which serves them to devices; see deploy/docker-compose.yml. The
  // local default keeps `npm run dev` out of the container's paths.
  firmwareDir:
    process.env.FIRMWARE_DIR || (process.env.NODE_ENV === "production" ? "/data/firmware" : ".firmware"),
};
