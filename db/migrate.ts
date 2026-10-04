/**
 * Applies db/migrations/NNN_*.sql in order, each once, each in a transaction.
 *
 * Run by ingest at startup, or by hand: `npm run migrate` (db/migrate-cli.ts). An advisory lock
 * makes it safe when several ingest containers start at the same time.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";

const LOCK_ID = 7_310_442; // any constant, shared by every runner

export async function migrate(sql: Sql, dir = path.resolve("db/migrations")): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  await sql.reserve().then(async (conn) => {
    try {
      await conn`select pg_advisory_lock(${LOCK_ID})`;
      await conn`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )`;
      const done = new Set((await conn<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));

      for (const file of files) {
        if (done.has(file)) continue;
        const body = await readFile(path.join(dir, file), "utf8");
        await conn.unsafe("begin");
        try {
          await conn.unsafe(body);
          await conn`insert into schema_migrations (name) values (${file})`;
          await conn.unsafe("commit");
        } catch (e) {
          await conn.unsafe("rollback");
          throw new Error(`migration ${file} failed: ${(e as Error).message}`);
        }
        applied.push(file);
      }
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
      conn.release();
    }
  });

  return applied;
}
