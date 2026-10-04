/**
 * The web app's database pool. Read-only use: ingest does all the writing.
 *
 * Kept on globalThis because `next dev` re-evaluates modules on every edit;
 * without that each hot reload would open another pool.
 */

import postgres from "postgres";
import { config } from "./config";

const g = globalThis as unknown as { __bmsSql?: postgres.Sql };

export const sql =
  g.__bmsSql ??
  (g.__bmsSql = postgres(config.databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 5,
    onnotice: () => {},
  }));
