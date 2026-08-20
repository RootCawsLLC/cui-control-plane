import duckdb from 'duckdb';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ROOT } from './lib/load.mjs';
import { TABLES, columnType } from './collectors/tables.mjs';

/**
 * The local warehouse: DuckDB, plus enough of dbt's templating to run the same model files.
 *
 * WHY NOT dbt ITSELF. dbt is Python. Requiring it would mean a junior analyst's first task is
 * getting a working Python toolchain past corporate endpoint controls, which is exactly the point
 * where an initiative like this dies. DuckDB is a native Node module with prebuilt binaries and no
 * server, so `npm install` is the whole setup.
 *
 * The models in models/ remain genuine dbt models - the same files, the same `{{ ref() }}` and
 * `{{ source() }}` and `{{ var() }}`. Moving to a real warehouse later is a dbt profile and a
 * dialect pass, not a rewrite. This runner resolves the three functions this project actually uses
 * and nothing else; it is not a Jinja engine and does not pretend to be, so an unsupported
 * expression fails loudly rather than rendering to something surprising.
 */

const LAYERS = ['staging', 'controls', 'intermediate', 'variance'];

export class Warehouse {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(resolve(ROOT, path)), { recursive: true });
    this.db = new duckdb.Database(path === ':memory:' ? ':memory:' : resolve(ROOT, path));
    this.conn = this.db.connect();
  }

  run(sql) {
    return new Promise((resolve, reject) => {
      this.conn.run(sql, (err) => (err ? reject(new Error(`${err.message}\n--- sql ---\n${sql}`)) : resolve()));
    });
  }

  all(sql) {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, rows) => (err ? reject(new Error(`${err.message}\n--- sql ---\n${sql}`)) : resolve(rows)));
    });
  }

  close() {
    return new Promise((resolve) => this.db.close(() => resolve()));
  }

  /**
   * Creates every landing table declared in tables.mjs, empty.
   *
   * This is what lets the pipeline run end to end on a half-configured deployment. A model that
   * references a source nobody collected would otherwise fail with "table not found", and the
   * analyst would have no idea whether their SQL was wrong or their config was. Instead the model
   * runs, returns nothing, and the assertion layer reports an unknown population - which is the
   * true answer and is very different from a pass.
   */
  async createLandingTables() {
    for (const [table, def] of Object.entries(TABLES)) {
      const cols = def.columns.map((c) => `"${c}" ${columnType(c)}`).join(', ');
      await this.run(`create table if not exists ${table} (${cols})`);
    }
  }

  /** Replaces a landing table with collected rows. Append-only history lives in .evidence, not here. */
  async load(table, rows) {
    const def = TABLES[table];
    if (!def) throw new Error(`unknown landing table ${table}`);
    await this.run(`delete from ${table}`);
    if (rows.length === 0) return 0;

    const cols = def.columns;
    const values = rows
      .map((r) => `(${cols.map((c) => literal(r[c])).join(', ')})`)
      .join(',\n');
    await this.run(`insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')}) values\n${values}`);
    return rows.length;
  }

  /** Runs every model in dependency order and materialises each as a view. */
  async buildModels({ asOf }) {
    const built = [];
    for (const layer of LAYERS) {
      const dir = join(ROOT, 'models', layer);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        const name = file.replace('.sql', '');
        const sql = render(readFileSync(join(dir, file), 'utf8'), { asOf });
        await this.run(`create or replace view ${name} as\n${sql}`);
        built.push(`${layer}/${name}`);
      }
    }
    return built;
  }
}

function literal(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  // An empty list is [], not NULL. array_length(NULL) is NULL and would make "no exemptions" and
  // "unknown exemptions" the same value, which they are not.
  if (Array.isArray(v)) return `[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(', ')}]`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Resolves the three dbt functions this project uses. Deliberately narrow.
 *
 * source('a','b')  -> src_a_b        the landing tables in tables.mjs
 * ref('model')     -> model          views built above
 * var('as_of')     -> the run's as_of, which is passed in and NEVER read from the clock in here -
 *                     the runner's clock is not an evidence timestamp
 */
export function render(sql, { asOf }) {
  let out = sql;

  out = out.replace(/\{\{\s*source\(\s*['"]([\w-]+)['"]\s*,\s*['"]([\w-]+)['"]\s*\)\s*\}\}/g, (_m, a, b) => `src_${a}_${b}`);
  out = out.replace(/\{\{\s*ref\(\s*['"]([\w-]+)['"]\s*\)\s*\}\}/g, (_m, a) => a);
  out = out.replace(/\{\{\s*var\(\s*["']as_of["']\s*\)\s*\}\}/g, () => asOf);

  // A set directive is used by the singular tests for a threshold.
  const setMatch = out.match(/\{%\s*set\s+(\w+)\s*=\s*([^%]+?)\s*%\}/);
  if (setMatch) {
    const [directive, name, value] = setMatch;
    out = out.replace(directive, '');
    out = out.replaceAll(`{{ ${name} }}`, value.trim());
  }

  const leftover = out.match(/\{\{[^}]*\}\}|\{%[^%]*%\}/);
  if (leftover) {
    throw new Error(
      `unsupported dbt expression: ${leftover[0]}\n` +
        'The local runner resolves ref(), source(), var("as_of") and a simple set. Anything richer ' +
        'needs real dbt - which the models are compatible with. See docs/SETUP.md.'
    );
  }
  return out;
}
