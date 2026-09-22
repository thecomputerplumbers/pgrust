# pgrust inside a Cloudflare Durable Object

Experimental, token-protected SQL playground: **https://pgrust.thecomputerplumbers.com**.

The Worker deploys to **The Computer Plumbers** account
`865d0c927a18e87c0a0701b8d1f18ee9`. The `workers.dev` and preview endpoints
are disabled. The custom domain belongs to the same account.

## What runs

Each named Durable Object owns a PostgreSQL-compatible pgrust WASM engine
and a private SQLite database. PostgreSQL queries are executed by pgrust.
SQLite stores filesystem metadata, immutable seed blocks, and modified
64 KiB file blocks; it does not interpret the user's PostgreSQL SQL.

The implementation uses pgrust's existing WASI host and `--single` mode,
with a fresh engine instance per request. `shared_buffers`, `work_mem`,
and `maintenance_work_mem` are each 1 MB. The measured engine linear
memory is approximately 79.4 MiB on the small test workload. This is **not**
a measurement of total isolate memory; the 128 MB limit also includes JS.

All filesystem changes made by one request run inside one synchronous
DO SQLite transaction. Engine shutdown performs its checkpoint before
the outer transaction completes. The response is released only after
`ctx.storage.sync()` completes. A thrown host error rolls back that
request's storage changes. The next request reconstructs metadata from
storage, so rolled-back in-memory state is never reused.

WASI `fsync` is deliberately deferred to the outer request transaction;
intermediate PostgreSQL commits are not externally acknowledged. This
is a request-level durability contract, not a general-purpose POSIX
filesystem or an independently durable pgwire session.

## Run locally

Requires Node 26 and pnpm 11.5.1. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm prepare:assets
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync(".dev.vars", `TEST_TOKEN=${randomBytes(32).toString("hex")}\n`, {mode:0o600, flag:"wx"})'
pnpm dev --port 8797
```

Open http://localhost:8797 and paste the token from `.dev.vars`. Connect,
choose “Create & insert”, and run the example. Click “Restart object”,
then run “Read saved rows” to verify persistence.

`prepare:assets` downloads the upstream browser engine and seed data,
verifies pinned SHA-256 hashes, and splits the seed into 1 MiB static
assets. A changed upstream download fails closed. Set `PGRUST_ASSET_DIR`
to a directory containing `postgres.wasm`, `vfs.img`, and `vfs.json` to
use an already downloaded copy with the same checksums.

The engine is the upstream pgrust 0.3 browser binary fetched on September
21, 2026, not a fresh source build or a Cloudflare-specific Rust build.
The source fork starts at `79ad992ede22bcf6ae0c4fdead6fb01eeac5a990`.
The binary's exact originating source revision has not been attested.
For production work, build and attest the engine from pinned source.
The original license and notices remain at the repository root.

## Tests

With the local Worker running:

```sh
pnpm test
pnpm smoke
TEST_URL=https://pgrust.thecomputerplumbers.com pnpm smoke
```

`smoke` reads the token from `.dev.vars` or `TEST_TOKEN`. It creates two
uniquely named disposable databases and checks:

- Authentication, engine version, arithmetic, and Unicode output.
- Create/insert/update, commit, and rollback.
- An injected host failure after engine shutdown but before durable commit.
- Explicit DO eviction using `ctx.abort()`, with a changed boot ID.
- Recovery of acknowledged writes and absence of uncommitted writes.
- Database isolation and five concurrent writes without lost updates.

Reports are saved in the ignored `test-results/` directory. These checks
are a small integration suite, not PostgreSQL conformance certification,
load testing, or a comprehensive crash-consistency proof.

## Deploy

Verify `pnpm exec wrangler whoami` and the explicit account in
`wrangler.jsonc` before deploying. From a committed checkout:

```sh
pnpm exec wrangler deploy --var "BUILD_COMMIT:$(git rev-parse HEAD)"
node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(readFileSync(".dev.vars","utf8").match(/^TEST_TOKEN=(.+)$/m)[1])' | pnpm exec wrangler secret put TEST_TOKEN
```

Keep the token private. It grants access to every database in this test
deployment. The UI stores it only in the browser tab's session storage.
The public health endpoint includes the deployed source commit. No
database SQL is available without the token. No CI deployment is configured.

## Current limits

- Test data only; upstream pgrust itself is not production-ready.
- HTTP API only. No public PostgreSQL TCP listener or direct `pg` driver connection.
- A transaction must start and finish within one request. No persistent
  temporary tables, prepared statements, or sessions across requests.
- Fresh engine startup and shutdown checkpoint on every request.
- First query copies the seed to the DO's storage, adding cold-start work.
- 16 KiB SQL request, 128 KiB engine output, 64 MiB per file,
  256 MiB logical filesystem, and a 50,000 page-read operation budget.
- SQL errors can coexist with earlier successful statements in a batch;
  use explicit PostgreSQL transactions when batch rollback is required.
- Table output is a rendering of the single-user diagnostic protocol,
  not a typed, parameterized application driver.
- The SQLite adapter inherits the upstream host's filesystem semantics;
  unsupported PostgreSQL features remain unsupported.
- The configured PostgreSQL statement timeout is best-effort in this
  WASM host. Cloudflare's CPU limit is the outer execution limit.
- Heavy queries can still exceed memory/CPU limits. The playground is
  not a public multi-tenant database service.

## Cleanup

Keep the deployment while experimenting. To retire it, first revoke
access with `pnpm exec wrangler secret delete TEST_TOKEN`, then deliberately
delete this Worker and its DO namespace in the Cloudflare dashboard.
Deleting only the custom domain does not remove stored databases.
Deleting the namespace removes **all** playground and smoke-test data.
