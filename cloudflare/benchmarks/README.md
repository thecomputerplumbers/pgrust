# pgrust versus native Durable Object SQLite

Measured September 21, 2026 (America/Denver), on
https://pgrust.thecomputerplumbers.com. Engine/benchmark source commit:
`1578b8d813e0e3e1aa327f511667852bc396e6d1`.

**Native SQLite is substantially faster for these small queries. The current
pgrust port pays for an engine startup and shutdown checkpoint on every
request, including reads.** This compares our experimental port, not native
pgrust on a server or a future persistent WASM session implementation.

## Live results

Server time below is the Worker-to-Durable-Object RPC round trip, including
routing, scheduling, execution, result conversion, and required durability.
It excludes the client's internet round trip and is not pure SQL CPU time.

| Workload | pgrust median / p95 | Native SQLite median / p95 | Median ratio |
| --- | ---: | ---: | ---: |
| `SELECT 1` | 286 / 357 ms | 11 / 15 ms | 26.0x |
| Primary-key lookup in 1,000 rows | 316 / 428 ms | 12 / 17 ms | 26.3x |
| Sum of 1,000 rows | 328 / 486 ms | 13 / 19 ms | 25.2x |
| Update one row, return value | 333 / 361 ms | 43 / 84 ms | 7.7x |
| 100 `SELECT 1`s in one request | 339 / 583 ms | 14 / 19 ms | 24.2x |

Client-observed HTTP median latency for `SELECT 1` was **334.8 ms** for
pgrust and **47.8 ms** for SQLite. Native SQLite's write timing includes
waiting for durability; neither path acknowledges a write early.

Batching 100 pgrust statements costs only 19% more than one constant query
in this run (339 versus 286 ms). This supports fixed per-request lifecycle
overhead as the dominant cost for these tiny queries. It does **not** mean
an individually issued query has 3.39 ms latency.

## Method and limits

- Same live Worker and **same Durable Object instance**, with one boot ID
  throughout the run, to control for routing and placement.
- Identical schema and 1,000 rows in both engines. SQLite operates directly
  through `ctx.storage.sql`, in a separate fixture table alongside the
  pgrust filesystem tables. This is not D1 or SQLite WASM.
- Three warmups, then 20 samples per engine per workload. Engine order
  alternates within each pair. Requests are sequential; no load test.
- Every returned result was checked. Setup and warmups are excluded.
- Client in the user's local environment; Worker ingress colo was DEN.
- p95 is the nearest-rank statistic; 20 samples is a small snapshot.
- Other workloads, cache states, placement, and platform load can differ.
- The native path uses the same explicit transaction wrapper and storage
  sync boundary; read-only requests normally have nothing to flush.

## Why the old UI timer was misleading

The initial playground timed the synchronous engine inside the Durable
Object. Cloudflare's clocks [only advance at I/O boundaries](https://developers.cloudflare.com/workers/runtime-apis/performance/).
The live report contains internal DO durations longer than the entire
observed HTTP request, as well as durations much shorter than the external
RPC. Those internal timings cannot be used as CPU or wall-time evidence.
The playground now measures the enclosing Worker-to-DO RPC and labels it
“server round trip.” This timing change does not make the engine faster.

## Local diagnosis

In local workerd, where timers advance during execution, `SELECT 1` took
38 ms median RPC time for pgrust versus 1 ms for native SQLite. The pgrust
stage medians were approximately:

| Stage | Median |
| --- | ---: |
| Load filesystem metadata | 1 ms |
| Build host / instantiate WASM | 4 ms |
| Engine startup, SQL, file operations, shutdown checkpoint | 17 ms |
| Flush metadata and format results | 1 ms |
| Await storage durability | 6 ms |

Stage medians need not sum to the median total. These are local machine
measurements, **not a breakdown of live Cloudflare execution time**.
One `SELECT 1` made 204 filesystem page accesses locally; 100 batched
`SELECT 1`s made the same 204 accesses and took 34 ms median RPC time.

## Implication

For this application shape, use native DO SQLite when PostgreSQL
compatibility is not required. If PostgreSQL behavior is essential, the
next experiment should keep a pgrust session alive across requests and
avoid a complete startup/shutdown checkpoint for each query, while
preserving durable commit, eviction recovery, and the isolate memory limit.
That architecture is not implemented or benchmarked here. Batching is
already available and amortizes the current fixed overhead.

Raw evidence: [live run](2026-09-21-live.json),
[local run](2026-09-21-local.json). Reproduce with `pnpm benchmark` or
`TEST_URL=https://pgrust.thecomputerplumbers.com pnpm benchmark` from
the `cloudflare` directory.
