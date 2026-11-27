# Conformance suite

One set of tests for the farm's HTTP API, run unchanged against the Bun backend
(`src/`, built to `build/server/bundle.js`) and the Rust backend
(`target/debug/turnip-farm-server`, PR 2). The tests drive a real server
process over HTTP against a real PostgreSQL database, with every outside
service (Apple, R2, the admin auth service) replaced by a fake. Neither
server has test-only code: each is started the way production starts it.

```bash
bun run test:conformance                 # both servers, then compare their answers
bun run test:conformance:bun             # the Bun server only
bun run test:conformance:rust            # the Rust server only (builds it first)
bun conformance/run.ts tests/sources.test.ts --tz America/Los_Angeles
cd conformance && CONFORMANCE_TARGET=bun bun test --timeout 30000 tests/sources.test.ts   # one file, directly
```

It needs a PostgreSQL the run may create databases in (default
`postgres:postgres@127.0.0.1:5432`; override with `CONFORMANCE_PG_HOST`,
`_PORT`, `_USER`, `_PASSWORD`), with `max_connections` of a few hundred
since each started server keeps a pool, and the `openssl` command.
`CONFORMANCE_VERBOSE=1` echoes each server's log.

Until the Rust backend exists (PR 2), `run.ts` runs the Bun target only and
skips the compare step: with no `Cargo.toml` and no Rust binary present,
`--target both` (the default) becomes `--target bun` with a note, and
`--target rust` exits 2. The CI `conformance` job gates its cargo steps the
same way. This gate is temporary; do not weaken the job permanently.

`compare-databases.ts` compares what two databases hold, table by table, for
checking the servers against each other on copies of real data.

## How it works

- **`harness/stack.ts`** — `startStack(options)` makes an empty database,
  runs `dbmate migrate` against it, starts the fakes, and starts the server
  named by `CONFORMANCE_TARGET` (`bun` or `rust`) on a free port. It returns
  a `Stack`: clients (`stack.anonymous()`, `stack.pipeline()`), the database
  (`stack.db`), the fakes (`stack.upstream`), the server's log (`stack.logs`,
  `stack.waitForLog`, `stack.logCount`), and `stack.restart()` (re-runs
  startup retention, resets in-memory rate limits). A file starts one stack
  in `beforeAll` and stops it in `afterAll`; a file that needs other settings
  (admin sign-in on, the ingest poller on) starts its own with `admin` /
  `ingestIntervalMs` / `beforeStart` / `env`. The Bun target runs the built
  bundle (`bun run build` first, done by `run.ts`), not source — static
  serving needs the built client.
- **`harness/upstreams/hub.ts`** — the servers call their upstreams at fixed
  `https://` hosts. Each is started with `HTTPS_PROXY` pointing at a local
  proxy that hands every connection to one TLS server holding a throwaway
  certificate the servers are told to trust (`harness/certs.ts`). Fakes
  register handlers per host with `hub.on(host, handler)`; every call is
  logged in `hub.requests` (`hub.seen(host, pathPrefix?)`).
- **`harness/upstreams/apple.ts`** (`FakeApple`) — Sign in with Apple:
  RS256 JWKS (`kid k1`, `addKey()` for rotation), single-use codes, identity
  tokens (the farm must never store the `email` / `is_private_email`
  claims), notification payloads, and client-secret verification on every
  token/revoke call (ES256 JWT: `kid = APPLE_KEY_ID`, `iss = APPLE_TEAM_ID`,
  `sub = APP_BUNDLE_ID`, `aud = https://appleid.apple.com`, exp ≤ 5 min
  after iat). `state.token` / `state.revoke` are replaceable handlers.
- **`harness/upstreams/r2.ts`** (`FakeR2`) — one shared in-memory store,
  served two ways: the virtual host the presigned URLs use and the path host
  the ingest store's header-signed requests use (SigV4 verified on both).
  A plain-HTTP local endpoint (`localOrigin`, `localUrl()`) lets tests PUT
  and GET through presigned URLs. Hooks: `failNext(operation, status)`
  (one-shot), `lieAboutLength(key, declaredBytes)` (streams that many zero
  bytes with no Content-Length — see "Pinned Bun behaviours"),
  `gateGet(key)` (holds GETs until released).
- **`harness/upstreams/auth.ts`** (`FakeAuth`) — the admin OIDC service:
  Ed25519 JWKS, discovery, authorize (code bound to `state` / `nonce` /
  PKCE), token (Basic auth, authorization-code and refresh-token grants),
  revocation, end-session, and security-event tokens (`event(type,
  fields)`). `state` replaces role, `amr`, `auth_time` age, and the
  token/revoke handlers; `setUnreachable(bool)` stops the listener.
- **`harness/client.ts`** — an HTTP client that keeps cookies like a browser
  tab and never follows redirects. Paths are under `/api` unless written
  with a leading `//`. It carries a bearer token as well as cookies
  (`withBearer()`, `fresh()` clears both).
- **`harness/postgres.ts`** — `stack.db.query/one/insert/rows` on the
  server's own database: seed what no endpoint creates, assert what a
  request stored. BIGINT columns come back as strings, TIMESTAMPTZ as
  `Date`.
- **`harness/transcript.ts` and `compare.ts`** — every exchange, and every
  upstream call, is recorded per target. After both targets ran, `compare.ts`
  diffs the two transcripts with generated values (ids, timestamps, tokens,
  Amz dates) masked. The test code being identical, any difference is a
  difference between the servers, including in fields no assertion looked
  at.
- **`harness/tkp1.ts`** — TKP1 fixtures, reimplemented from
  `docs/POSE_FORMAT.md` and `src/ingest/tkp1-codec.ts` (not imported from
  `src/`): `encodeStagedTkp1` (gzip), `decodeTkp1`, `makeFrame`,
  `GAP_FRAME`, `sha256Hex`. The canonical gzip is the farm's own blocked
  framing, so fixtures are staged blobs, never canonical ones.
- **`harness/apple.ts`, `harness/admin.ts`, `harness/seed/*`** — the
  sign-in driver (`signIn`, `consented`, `videoId`, `sourceKey`,
  `nextAddress`), the admin login driver (`adminLogin`,
  `seedAdminSession`, `postAuthEvent`), and direct-DB seeders
  (`seedSession`, `seedSource`, `seedClip`, `seedModel`,
  `seedQuarantine`, `candidateHash`).

## Writing tests

A test file covers one group of endpoints, **every branch of each**: read the
route and the functions it calls, and write a case for every `return`, every
thrown error, and every condition that changes what is stored. The stored
result is read back through `stack.db`, not only the response; what the server
asked its upstreams is asserted through `stack.upstream.<fake>.seen()`.
Assert whole response bodies with `toEqual`, building the expected value from
what the test created; match generated values by shape
(`expect.stringMatching`, `expect.any(String)`). Do not assume a time zone or
today's date — compute dates from `new Date()` with local-time methods.

- Every `POST /api/consent` and `POST /api/sources` carries
  `"storefront_country": "USA"` unless the test is about the region gate —
  otherwise the region refusal fires before auth and the test fails for the
  wrong reason.
- Sign-in is per-IP rate limited (10/min): `signIn` takes a fresh
  `X-Forwarded-For` address per call unless the test is probing the bucket
  itself. Give requests that touch a rate limit their own address via
  `nextAddress()`; limits are per address and live for the server process.
- Mark an exchange whose answer is inherently different per run with
  `noCompare: true` so the transcript diff skips it; say why in a comment.
- Wrap a request whose upstream calls the Bun server starts at once, and
  which reach the upstream in no fixed order there, in
  `stack.upstream.hub.unordered(() => …)`: the diff then compares the calls
  that arrived meanwhile as a set, per host. Use it only where the Bun
  server's own order is racy, and say why in a comment.
- Wait for background effects with `stack.waitFor(() => …)` or
  `stack.waitForLog(…)`, never with a fixed sleep. The one exception is the
  single refill wait in `ratelimit.test.ts`, which waits on a token
  refilling (about a second) through `waitFor`, not a sleep.
- Write the test against the Bun server first: it is the reference. Then run
  it against Rust, then run both through `conformance/run.ts` and bring the
  transcript diff to zero.

## Pinned Bun behaviours

The Bun server is the reference, so where it does something that looks like
a bug, the suite pins what it does and the Rust server copies it. Each test
that pins one says so in a comment above it. Fixing one means changing both
servers and that test together.

| Behaviour | Pinned in |
|---|---|
| Bun normalizes `..` and `%2e%2e` segments in the request target before the handler sees them, so `/../package.json` answers like `/package.json` (the SPA shell). Encoded-slash (`/..%2f…`) and NUL (`/..%00…`) escapes do reach the handler and answer 404. The escape paths are probed with a raw TCP socket because `fetch` normalizes them first. | `static.test.ts` |
| `Bun.serve` rewrites a stream `Response`'s `Content-Length` to the actual body length, so a fake cannot lie about a blob's length through a header. `FakeR2.lieAboutLength` instead streams the declared number of zero bytes with no Content-Length, and the farm's counted-bytes cap rejects past 64 MiB. The declared-length header-check branch is unit-level only. | `clips.test.ts`, `admin-sources.test.ts` |
| A body over 1 MiB on a 1 MiB route never reaches the handler: `Bun.serve`'s `maxRequestBodySize` is the largest route cap (1 MiB), so the answer is a bare 413 — empty body, `connection: close` — not the route's 422 `BodyTooLargeError`. The 422 only fires for routes whose cap sits below 1 MiB (sources 64 KiB, models 128 KiB). | `http.test.ts`, `clips.test.ts`, `quarantine.test.ts` |
| On `GET /api/admin/sources/:id/pose` the cap is raised by the response stream, not by `getStream`: the handler has already answered 200 and the body read fails after at most one chunk past 64 MiB. | `admin-sources.test.ts` |
| The canonical gzip is the farm's own blocked framing (mtime 0, 64 KiB deflate blocks with `Z_SYNC_FLUSH`), not a plain `gzipSync` of the payload — so canonical bytes differ from the staged bytes even for a 10 Hz passthrough. What is identical is the decoded content. The canonical header keeps the source sample rate; the frames are the 10 Hz resample. | `ingest.test.ts` |
| HEAD on a GET route is 404: the farm's router matches the method exactly; `Bun.serve` does not synthesize a HEAD answer from a GET route. | `http.test.ts` |
| A wrong method on a known path is 404 in the API error shape, never 405. | `http.test.ts`, `health.test.ts` |

## Deviations from the design doc

Two places where the code, not `conformance-design.md`, is authoritative; the
tests assert the code and the PR notes both.

- **Model publish consumes every staged page for the version.**
  `src/models.ts` deletes all `model_training_source_pages` for the version
  on publish, not only the pages whose `sha256` matches the published model
  as §5 says. Pinned in `models.test.ts`.
- **Over-1MiB bodies answer 413, not 422.** The design's "clips body over
  1 MiB → 422" does not hold for the Bun target (see the 413 row above).
  Pinned in `http.test.ts`, `clips.test.ts`, `quarantine.test.ts`.

## Open questions (design §9)

- The Amz-date mask in `compare.ts` is unverified until both targets exist
  (PR 2): it must be checked against a real transcript pair.
- The TKP1 fixtures are reimplemented from `POSE_FORMAT.md` plus the codec;
  cross-check them once against the farm's `decodeTkp1` in a one-off script,
  not a suite test.
- The untrusted-peer `X-Forwarded-For` branch is untestable over HTTP
  (unit-test only).
- The `GET /api/stats` midnight-UTC straddle can diff between parallel
  targets; accepted, same as budget.
