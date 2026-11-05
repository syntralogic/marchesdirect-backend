// Charge le backend compilé avec un faux « pg » qui exécute le vrai SQL sur le Postgres local (psql), et des modules
// factices pour les dépendances absentes. Sert uniquement aux tests locaux.
const Module = require('module'); const { execFileSync } = require('child_process');
const lit = v => { if (v === null || v === undefined) return 'NULL'; if (Array.isArray(v)) return `ARRAY[${v.map(lit).join(',')}]`+(v.length? '':'::text[]');
  if (typeof v === 'number') return String(v); if (typeof v === 'boolean') return v ? 'true' : 'false'; if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`; return `'${String(v).replace(/'/g, "''")}'`; };
function run(sql, params = []) {
  const s = sql.replace(/\$(\d+)/g, (_, n) => lit(params[+n - 1]));
  const isSelect = /^\s*(SELECT|WITH)\b/i.test(s);
  const q = isSelect ? `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${s.replace(/;\s*$/, '')}) t` : s;
  try {
    const out = execFileSync('psql', ['-h', '/var/tmp/mdpg', '-p', '5544', '-U', 'postgres', '-d', 'md', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: q + ';', encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
    if (process.env.SQLLOG) require('fs').appendFileSync(process.env.SQLLOG, s + ';\n\n');
    if (!isSelect) return { rows: [], rowCount: 0 };
    const txt = out.trim(); try { return { rows: JSON.parse(txt || '[]'), rowCount: 0 }; } catch (e2) { throw new Error('JSON: ' + e2.message + ' :: ' + txt.slice(0, 600)); }
  } catch (e) { const err = new Error((e.stderr || e.message).toString().split('\n')[0] + '\nSQL: ' + s.slice(0, 1500)); throw err; }
}
class Pool { constructor() {} on() {} async query(sql, params) { return run(typeof sql === 'object' ? sql.text : sql, typeof sql === 'object' ? sql.values : params); }
  async connect() { return { query: (a, b) => this.query(a, b), release() {} }; } async end() {} }
const stub = new Proxy(function () { return stub; }, { get: (t, k) => (k === '__esModule' ? false : k === 'default' ? stub : k === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
const fakes = { pg: { Pool, types: { setTypeParser() {} } }, express: (() => { const R = () => { const r = { routes: [] }; r.param = () => r; r.all = () => r; r.route = () => r; for (const m of ['get', 'post', 'put', 'delete', 'patch', 'use']) r[m] = (p, ...h) => { r.routes.push({ m, p, h }); return r; }; return r; }; const e = () => ({ use() {}, get() {}, listen() {} }); e.Router = R; e.json = () => () => {}; return e; })() };
const orig = Module._load;
Module._load = function (req, parent, isMain) { if (fakes[req]) return fakes[req]; try { return orig.apply(this, arguments); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && !req.startsWith('.') && !req.startsWith('/')) return stub; throw e; } };
process.env.DATABASE_URL = 'postgres://x'; process.env.JWT_SECRET = 'test-local-only-'+Math.random(); process.env.REFRESH_TOKEN_SECRET = 'test-local-only-'+Math.random(); module.exports = { run };
