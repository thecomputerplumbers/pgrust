import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://localhost:8797';
const token = process.env.TEST_TOKEN || (await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).match(/^TEST_TOKEN=(.+)$/m)?.[1];
assert(token, 'TEST_TOKEN is required');
const database = process.env.TEST_DATABASE || `smoke-${Date.now()}`;
const results = [];
async function call(action, body, db = database) {
  const response = await fetch(`${base}/api/db/${db}/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, ...data };
}
async function query(sql) {
  const result = await call('query', { sql });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true, result.diagnostics);
  assert(result.memoryBytes < 100 * 1048576, 'WASM memory headroom');
  results.push({ sql, elapsedMs: result.elapsedMs, memoryBytes: result.memoryBytes, bootId: result.bootId });
  return result;
}
const unauthenticated = await fetch(`${base}/api/db/${database}/status`);
assert.equal(unauthenticated.status, 401);
console.log('PASS unauthenticated requests rejected');
const version = await query('SELECT version(); SELECT 6*7 AS answer;');
assert.match(version.raw, /PostgreSQL 18.6 \(pgrust 0.3\)/);
assert.match(version.raw, /answer = "42"/);
console.log('PASS pgrust version and arithmetic');
const unicode = await query("SELECT '数据🐘库'::text AS value;");
assert.match(unicode.raw, /value = "数据🐘库"/);
console.log('PASS Unicode output');
await query("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO probe VALUES (1, 'durable');");
await query("BEGIN; INSERT INTO probe VALUES (2, 'rolled back'); ROLLBACK;");
await query("BEGIN; INSERT INTO probe VALUES (3, 'committed'); COMMIT; UPDATE probe SET value='updated' WHERE id=3;");
const rows = await query('SELECT count(*) AS total FROM probe; SELECT value FROM probe WHERE id=3;');
assert.match(rows.raw, /total = "2"/);
assert.match(rows.raw, /value = "updated"/);
console.log('PASS create, insert, update, commit, rollback');
const failure = await call('query', { sql: "INSERT INTO probe VALUES (4, 'must not survive');", failBeforeCommit: true });
assert.equal(failure.status, 500);
assert.match(failure.error, /Injected failure/);
const afterFailure = await query('SELECT count(*) AS total FROM probe;');
assert.match(afterFailure.raw, /total = "2"/);
console.log('PASS failure before commit rolls back storage');
const before = await call('status');
await call('restart', {});
const after = await call('status');
assert.notEqual(before.bootId, after.bootId);
const persisted = await query('SELECT count(*) AS total FROM probe; SELECT value FROM probe WHERE id=1;');
assert.match(persisted.raw, /total = "2"/);
assert.match(persisted.raw, /value = "durable"/);
console.log('PASS forced object restart preserves acknowledged writes');
const isolated = await call('query', { sql: "SELECT count(*) AS total FROM information_schema.tables WHERE table_name='probe';" }, `${database}-other`);
assert.equal(isolated.ok, true, JSON.stringify(isolated));
assert.match(isolated.raw, /total = "0"/);
console.log('PASS separate object has independent database');
const parallel = await Promise.all(Array.from({ length: 5 }, (_, i) => query(`INSERT INTO probe VALUES (${10+i}, 'parallel');`)));
assert.equal(parallel.length, 5);
const counted = await query('SELECT count(*) AS total FROM probe;');
assert.match(counted.raw, /total = "7"/);
console.log('PASS concurrent requests serialize without lost writes');
const report = { base, database, timestamp: new Date().toISOString(), passed: true, results };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const reportPath = new URL(`../test-results/${database}.json`, import.meta.url);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`PASS all checks; database=${database}; report=${reportPath.pathname}`);
