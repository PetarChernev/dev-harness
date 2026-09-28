import Database from 'better-sqlite3';
import { join } from 'node:path';
import { z } from 'zod';
import { identity, processState, uid } from './util.js';

const ownerSchema = z.object({ pid: z.number().int().positive(), start: z.string().nullable(), nonce: z.string(), created: z.number() }).strict();
/** OS ownership is separate from task leases. No time-based lock stealing. */
export class Ownership {
  readonly path: string;
  readonly db: Database.Database;
  readonly owner = { ...identity(), nonce: uid('owner'), created: Date.now() };
  constructor(runtime: string) {
    this.path = join(runtime, 'ownership.sqlite');
    this.db = new Database(this.path);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
    try {
      this.db.transaction(() => {
        const row = this.db.prepare('SELECT body FROM owner WHERE id=1').get() as { body: string } | undefined;
        if (row && processState(ownerSchema.parse(JSON.parse(row.body))) !== 'dead') throw new Error('state service already owned or ownership uncertain; use authenticated control API');
        this.db.prepare('INSERT INTO owner VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(this.owner));
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  assert(): void {
    const row = this.db.prepare('SELECT body FROM owner WHERE id=1').get() as { body: string } | undefined;
    if (!row || ownerSchema.parse(JSON.parse(row.body)).nonce !== this.owner.nonce) throw new Error('exclusive ownership lost');
  }
  close(): void { this.assert(); this.db.prepare('DELETE FROM owner WHERE id=1').run(); this.db.close(); }
}
