import { DurableObject } from 'cloudflare:workers';
import postgres from '../generated/postgres.wasm';
import { makeWasi, GuestExit } from '../../wasm/pgrust-wasi.js';
import { normalizeSingleUserInput, formatSingleUser, decodeUtf8Chunks } from '../../wasm/format.js';
import { SqliteVfs, createSchema, seedMetadata, PAGE_SIZE } from './sqlite-vfs.js';
import { benchmarkSetup, benchmarkQueries } from './benchmark.js';

const argv = ['postgres', '--single', '-D', '/pgdata',
  '-c', 'max_stack_depth=60000', '-c', 'io_method=sync', '-c', 'autovacuum=off',
  '-c', 'wal_sync_method=fdatasync', '-c', 'shared_buffers=1MB',
  '-c', 'work_mem=1MB', '-c', 'maintenance_work_mem=1MB',
  '-c', 'max_connections=4', '-c', 'max_worker_processes=0',
  '-c', 'max_parallel_workers=0', '-c', 'statement_timeout=5000', 'postgres'];

export class PgRustDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bootId = crypto.randomUUID();
    createSchema(ctx.storage.sql);
  }

  async initialize() {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT value FROM settings WHERE key = 'ready'").toArray().length) return;
    const get = async (name) => {
      const r = await this.env.ASSETS.fetch(new Request(`https://seed.invalid/seed/${name}`));
      if (!r.ok) throw new Error(`Seed asset unavailable: ${name}`);
      return r;
    };
    const manifest = await (await get('manifest.json')).json();
    for (let index = 0; index < manifest.chunks.length; index++) {
      const data = new Uint8Array(await (await get(manifest.chunks[index])).arrayBuffer());
      this.ctx.storage.transactionSync(() => {
        for (let off = 0; off < data.length; off += PAGE_SIZE) {
          const page = data.subarray(off, off + PAGE_SIZE);
          // Sparse pages are implicitly zero. The seed contains a mostly empty WAL.
          if (page.some(byte => byte !== 0)) {
            sql.exec('INSERT OR REPLACE INTO seed_pages (page, data) VALUES (?, ?)',
              index * (1048576 / PAGE_SIZE) + off / PAGE_SIZE, page);
          }
        }
      });
    }
    this.ctx.storage.transactionSync(() => {
      seedMetadata(sql, manifest);
      sql.exec("INSERT INTO settings (key, value) VALUES ('ready', '1')");
    });
    await this.ctx.storage.sync();
  }

  async query(input, failBeforeCommit = false) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.initialize();
      const started = performance.now();
      const result = this.execute(input, failBeforeCommit);
      // execute() returns before awaiting durability, releasing every reference
      // to the ~80 MiB WASM instance while another object may run in this isolate.
      await this.ctx.storage.sync();
      return { ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
    });
  }

  execute(input, failBeforeCommit) {
    const started = performance.now();
    const vfs = new SqliteVfs(this.ctx.storage.sql);
    const metadataLoaded = performance.now();
    const outputChunks = [], diagnosticChunks = [];
    let stdout = '', stderr = '', outputBytes = 0;
    const sink = (kind) => (bytes) => {
      outputBytes += bytes.length;
      if (outputBytes > 131072) throw new Error('Query output exceeds 128 KiB limit');
      (kind === 'out' ? outputChunks : diagnosticChunks).push(bytes);
    };
    const host = makeWasi({ vfs, argv, stdinBytes: normalizeSingleUserInput(input),
      onStdout: sink('out'), onStderr: sink('err') });
    // A precompiled module is imported by Wrangler; no runtime compilation.
    const instance = new WebAssembly.Instance(postgres, { wasi_snapshot_preview1: host.wasi });
    host.setMemory(instance.exports.memory);
    const instantiated = performance.now();
    let stats;
    let engineFinished;
    this.ctx.storage.transactionSync(() => {
      try { instance.exports._start(); }
      catch (error) {
        if (!(error instanceof GuestExit && error.code === 0)) throw error;
      }
      engineFinished = performance.now();
      stdout = decodeUtf8Chunks(outputChunks);
      stderr = decodeUtf8Chunks(diagnosticChunks);
      if (/\b(?:FATAL|PANIC):/.test(stderr)) throw new Error(stderr.slice(-4096));
      stats = vfs.flush();
      if (failBeforeCommit) throw new Error('Injected failure before durable commit');
    });
    return {
      ok: !/\bERROR:/.test(stderr), output: stdout.split(/^backend> /m)
        .filter(part => part.includes('(typeid =')).map(formatSingleUser).join('\n\n'), raw: stdout,
      diagnostics: stderr, bootId: this.bootId,
      memoryBytes: instance.exports.memory.buffer.byteLength,
      ...stats,
      // Local workerd has advancing timers. Cloudflare freezes synchronous
      // timers, so these stages are for local diagnosis, not live CPU claims.
      localStageMs: {
        metadata: metadataLoaded - started,
        instantiate: instantiated - metadataLoaded,
        engineAndFilesystem: engineFinished - instantiated,
        flushAndFormat: performance.now() - engineFinished,
      },
    };
  }

  prepareBenchmark() {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.initialize();
      const result = this.execute(benchmarkSetup.join(';') + ';', false);
      if (!result.ok) throw new Error(result.diagnostics);
      this.ctx.storage.transactionSync(() => {
        for (const sql of benchmarkSetup) this.ctx.storage.sql.exec(sql).toArray();
      });
      await this.ctx.storage.sync();
      return { ok: true, rows: 1000, bootId: this.bootId };
    });
  }

  benchmark(engine, scenario) {
    if (!['pgrust', 'sqlite'].includes(engine) || !Object.hasOwn(benchmarkQueries, scenario)) throw new Error('Unknown benchmark');
    return this.ctx.blockConcurrencyWhile(async () => {
      const started = performance.now();
      const queries = benchmarkQueries[scenario];
      let result;
      if (engine === 'pgrust') {
        result = this.execute(queries.join(';') + ';', false);
        if (!result.ok) throw new Error(result.diagnostics);
        result = { answers: [...result.raw.matchAll(/answer = "([0-9]+)"/g)].map(match => Number(match[1])),
          localStageMs: result.localStageMs, filesystemOperations: result.filesystemOperations,
          memoryBytes: result.memoryBytes };
      } else {
        const answers = [];
        this.ctx.storage.transactionSync(() => {
          for (const sql of queries) answers.push(...this.ctx.storage.sql.exec(sql).toArray().map(row => row.answer));
        });
        result = { answers, localStageMs: { nativeExecution: performance.now() - started } };
      }
      const executed = performance.now();
      await this.ctx.storage.sync();
      return { ok: true, engine, scenario, bootId: this.bootId, ...result,
        localStageMs: { ...result.localStageMs, durability: performance.now() - executed },
        elapsedMs: performance.now() - started };
    });
  }

  status() {
    return { bootId: this.bootId, initialized: this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key = 'ready'").toArray().length > 0 };
  }

  restart() { this.ctx.abort('Explicit test restart: durable data retained'); }
}

async function authorized(request, env) {
  if (!env.TEST_TOKEN) return false;
  const supplied = request.headers.get('Authorization') || '';
  const encode = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(supplied)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(`Bearer ${env.TEST_TOKEN}`)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, engine: 'pgrust-wasm', storage: 'durable-object-sqlite', experimental: true, buildCommit: env.BUILD_COMMIT || 'development' });
    if (url.pathname.startsWith('/api/')) {
      if (!await authorized(request, env)) return Response.json({ error: 'Test token required' }, { status: 401 });
      const match = /^\/api\/db\/([a-z0-9-]{1,48})\/(query|status|restart|benchmark|benchmark-prepare)$/.exec(url.pathname);
      if (!match) return new Response('Not found', { status: 404 });
      const stub = env.DATABASES.getByName(match[1]);
      try {
        if (match[2] === 'status' && request.method === 'GET') return Response.json(await stub.status());
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        if (match[2] === 'restart') {
          try { await stub.restart(); } catch { /* ctx.abort intentionally rejects the RPC */ }
          return Response.json({ restarted: true });
        }
        if (match[2] === 'benchmark-prepare') return Response.json(await stub.prepareBenchmark());
        const body = await request.text();
        if (body.length > 16384) return Response.json({ error: 'SQL request limit is 16 KiB' }, { status: 413 });
        const input = JSON.parse(body);
        if (match[2] === 'benchmark') {
          const started = performance.now();
          const result = await stub.benchmark(input.engine, input.scenario);
          return Response.json({ ...result, rpcMs: performance.now() - started,
            workerColo: request.cf?.colo || 'local', buildCommit: env.BUILD_COMMIT || 'development' },
            { headers: { 'Cache-Control': 'no-store' } });
        }
        if (typeof input.sql !== 'string' || !input.sql.trim()) return Response.json({ error: 'sql must be nonempty text' }, { status: 400 });
        const started = performance.now();
        const result = await stub.query(input.sql, input.failBeforeCommit === true);
        // The RPC is a real I/O boundary. Timers inside the synchronous WASM
        // engine can be stale/frozen, so do not display that duration as latency.
        return Response.json({ ...result, elapsedMs: performance.now() - started,
          timingScope: 'worker-do-rpc' }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }
    if (!['/', '/index.html', '/app.js', '/style.css'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  }
};
