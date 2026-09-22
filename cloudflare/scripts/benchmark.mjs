import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://localhost:8797';
const token = process.env.TEST_TOKEN || (await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).match(/^TEST_TOKEN=(.+)$/m)[1];
const database = process.env.TEST_DATABASE || `benchmark-${Date.now()}`;
const samples = Number(process.env.BENCHMARK_SAMPLES || 20);
assert(Number.isInteger(samples) && samples >= 5 && samples <= 100);
async function call(action, body = {}) {
  const start = performance.now();
  const r = await fetch(`${base}/api/db/${database}/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await r.json();
  assert(r.ok && result.ok, JSON.stringify(result));
  return { ...result, roundTripMs: performance.now() - start };
}
console.log(`Preparing 1,000 identical rows in both engines in the same DO: ${database}`);
await call('benchmark-prepare');
const raw = [], summaries = [];
const quantile = (values, q) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*q)-1)];
const summary = values => ({ median: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) });
for (const scenario of ['select1', 'point', 'scan', 'update', 'batch100']) {
  for (let i = -3; i < samples; i++) {
    // Alternate order within each pair to reduce ordering/time drift bias.
    for (const engine of i % 2 === 0 ? ['pgrust','sqlite'] : ['sqlite','pgrust']) {
      const result = await call('benchmark', { engine, scenario });
      const answer = scenario === 'point' ? 1500 : scenario === 'scan' ? 1501500 : scenario === 'update' ? 1504+i : 1;
      assert.deepEqual(result.answers, Array(scenario === 'batch100' ? 100 : 1).fill(answer));
      if (i >= 0) raw.push({ ...result, sample: i });
    }
  }
  for (const engine of ['pgrust','sqlite']) {
    const rows = raw.filter(row => row.engine === engine && row.scenario === scenario);
    const result = { scenario, engine, samples, rpcMs: summary(rows.map(r => r.rpcMs)),
      roundTripMs: summary(rows.map(r => r.roundTripMs)), doMs: summary(rows.map(r => r.elapsedMs)),
      localStageMs: Object.fromEntries(Object.keys(rows[0].localStageMs).map(key => [key, summary(rows.map(r => r.localStageMs[key]))])),
      filesystemOperations: rows[0].filesystemOperations,
    };
    summaries.push(result);
    console.log(`${scenario.padEnd(9)} ${engine.padEnd(6)} RPC median=${result.rpcMs.median.toFixed(2)}ms p95=${result.rpcMs.p95.toFixed(2)}ms; client median=${result.roundTripMs.median.toFixed(2)}ms`);
  }
}
const report = { timestamp: new Date().toISOString(), base, database, samplesPerEnginePerScenario: samples,
  warmupsPerEnginePerScenario: 3, sameDurableObject: true, summaries, raw,
  timingNote: 'RPC time is Worker->DO->Worker wall time, including routing, queueing, execution and required durability. Local stages are valid only in local workerd: deployed synchronous timers do not advance. Client time includes network/auth/response. Setup and warmups excluded.' };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const output = new URL(`../test-results/${database}.json`, import.meta.url);
await writeFile(output, JSON.stringify(report, null, 2));
console.log(`Report: ${output.pathname}`);
