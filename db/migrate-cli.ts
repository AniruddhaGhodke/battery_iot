/** `npm run migrate`: apply pending migrations without starting ingest. */

import postgres from "postgres";
import { migrate } from "./migrate.ts";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://bms:bms_local@localhost:5433/bms", {
  onnotice: () => {},
});
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
} finally {
  await sql.end();
}
