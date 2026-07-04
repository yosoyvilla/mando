import type postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function runMigrations(sql: ReturnType<typeof postgres>) {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`;
  const dir = join(import.meta.dir, "..", "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await sql`select 1 from _migrations where name = ${f}`;
    if (done.length) continue;
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    await sql`insert into _migrations (name) values (${f})`;
  }
}

if (import.meta.main) {
  const { getDb } = await import("./client");
  const { loadConfig } = await import("../config");
  await runMigrations(getDb(loadConfig(process.env).databaseUrl));
  process.exit(0);
}
