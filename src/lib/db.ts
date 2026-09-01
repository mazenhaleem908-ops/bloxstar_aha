// Neon PostgreSQL access layer.
//
// Uses the Neon serverless HTTP driver, which works on Vercel (Node and Edge)
// without a persistent TCP connection pool.
//
// Required environment variable:
//   DATABASE_URL=postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | undefined;

/** Lazily-created Neon SQL tag. Call inside request handlers only. */
export function db(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      const message =
        "Missing DATABASE_URL. Set it to your Neon PostgreSQL connection string.";
      console.error(`[db] ${message}`);
      throw new Error(message);
    }
    _sql = neon(url);
  }
  return _sql;
}

export type Row = Record<string, unknown>;
