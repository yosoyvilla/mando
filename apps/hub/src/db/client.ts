import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

export function getDb(url: string) {
  if (!sql) sql = postgres(url, { max: 10 });
  return sql;
}
