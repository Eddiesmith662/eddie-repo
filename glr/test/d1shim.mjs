// A stand-in for Cloudflare D1 using Node's built-in SQLite, so the site runs in tests without Cloudflare.
// Covers what the site uses: prepare().bind().all()/first()/run() and batch().
import { DatabaseSync } from "node:sqlite";

export function makeD1(file = ":memory:") {
  const raw = new DatabaseSync(file);
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a.map(v => v === undefined ? null : v)); }
    _s() { return raw.prepare(this.sql); }
    async all() {
      const s = this._s();
      return { results: /^\s*(SELECT|WITH|PRAGMA)/i.test(this.sql) ? s.all(...this.args) : (s.run(...this.args), []) };
    }
    async first() { return this._s().get(...this.args) ?? null; }
    async run() { this._s().run(...this.args); return { success: true }; }
  }
  return {
    raw,
    prepare: sql => new Stmt(sql),
    async batch(list) {
      raw.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.run()); raw.exec("COMMIT"); return out; }
      catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}
