import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1StatementLike, D1ResultLike } from "../../src/store/db.js";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

/** An in-memory D1 stand-in on node:sqlite, with the real migrations applied. */
export function testDb(): D1Like & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  const statement = (sql: string, values: unknown[] = []): D1StatementLike => {
    const args = () => values as SQLInputValue[];
    return {
      bind: (...v) => statement(sql, v),
      run: async (): Promise<D1ResultLike> => {
        const r = sqlite.prepare(sql).run(...args());
        return { meta: { changes: Number(r.changes) } };
      },
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...args()) as T[] }),
      first: async <T>() => (sqlite.prepare(sql).get(...args()) as T | undefined) ?? null,
    };
  };

  return {
    sqlite,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
