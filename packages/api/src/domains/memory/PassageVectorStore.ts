// F209 Phase A: passage-level vector CRUD for raw semantic / hybrid recall.

import type Database from 'better-sqlite3';

export function passageVectorKey(docAnchor: string, passageId: string): string {
  return JSON.stringify([docAnchor, passageId]);
}

export function parsePassageVectorKey(key: string): { docAnchor: string; passageId: string } {
  const parsed = JSON.parse(key) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error(`Invalid passage vector key: ${key}`);
  }
  return { docAnchor: parsed[0], passageId: parsed[1] };
}

/** Escape a user-supplied value for use in a SQLite LIKE pattern. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * F247 Phase B: produce a passage_key prefix that matches the JSON encoding of
 * ["sandbox:<sandboxId>:", ...]. sqlite-vec stores passage_key as the primary
 * key text column, so a LIKE predicate can scope the ANN search before top-k.
 */
function sandboxPassageKeyPrefix(sandboxId: string): string {
  return '[' + JSON.stringify(`sandbox:${sandboxId}:`).slice(0, -1);
}

export class PassageVectorStore {
  constructor(
    private db: Database.Database,
    private dim: number,
  ) {}

  upsert(passageKey: string, embedding: Float32Array): void {
    // vec0 does not support ON CONFLICT; mirror VectorStore's delete+insert.
    this.db.prepare('DELETE FROM passage_vectors WHERE passage_key = ?').run(passageKey);
    this.db.prepare('INSERT INTO passage_vectors (passage_key, embedding) VALUES (?, ?)').run(passageKey, embedding);
  }

  delete(passageKey: string): void {
    this.db.prepare('DELETE FROM passage_vectors WHERE passage_key = ?').run(passageKey);
  }

  search(
    queryVec: Float32Array,
    k: number,
    options?: { sandboxId?: string },
  ): Array<{ passageKey: string; distance: number }> {
    if (!options?.sandboxId) {
      return this.db
        .prepare(
          `SELECT passage_key as passageKey, distance FROM passage_vectors
      WHERE embedding MATCH ? AND k = ?`,
        )
        .all(queryVec, k) as Array<{ passageKey: string; distance: number }>;
    }

    // F247 Phase B: sqlite-vec evaluates k before additional WHERE predicates,
    // so a scoped LIKE alone can return empty when global passages rank higher.
    // We iteratively widen the candidate pool until we collect k scoped hits or
    // exhaust the index.
    const prefix = sandboxPassageKeyPrefix(options.sandboxId);
    const total = this.count();
    const maxPool = Math.max(total, k);
    let pool = k;
    const out: Array<{ passageKey: string; distance: number }> = [];
    const stmt = this.db.prepare(
      `SELECT passage_key as passageKey, distance FROM passage_vectors
       WHERE embedding MATCH ? AND k = ?`,
    );

    while (pool <= maxPool) {
      const rows = stmt.all(queryVec, pool) as Array<{ passageKey: string; distance: number }>;
      for (const row of rows) {
        if (row.passageKey.startsWith(prefix)) {
          out.push(row);
          if (out.length >= k) return out;
        }
      }
      if (rows.length < pool || pool === maxPool) break; // exhausted the index or final pool already queried
      pool = Math.min(pool * 2, maxPool);
    }
    return out;
  }

  clearAll(): void {
    this.db.exec('DELETE FROM passage_vectors');
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) as c FROM passage_vectors').get() as { c: number }).c;
  }
}
