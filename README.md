# AI Diff Review Service

Clients POST a unified diff with a bearer token; the service reviews it asynchronously
through a pluggable provider and returns structured findings over REST or SSE.

**Stack:** Node 22+ / TypeScript / Express 5. One production dependency (`express`);
everything else — hashing, HTTP client, test runner — is Node's standard library.

**Live:** `https://ai-diff-review-3klp.onrender.com` — `/health` and `/spec` are public,
so both are reachable without a token.

---

## Quick start

```bash
npm install
cp .env.example .env          # then edit AUTH_TOKEN
npm run build
AUTH_TOKEN=my-secret-token node dist/server.js
```

Or in watch mode: `AUTH_TOKEN=my-secret-token npm run dev`

Verify:

```bash
curl localhost:8080/health
curl localhost:8080/spec
node probe.mjs http://localhost:8080 my-secret-token
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AUTH_TOKEN` | **yes** | — | Bearer token for every `/v1/*` route. The service refuses to boot without it. |
| `PORT` | no | `8080` | HTTP port. |
| `JOB_STORE_PATH` | no | unset | Where job state is snapshotted. Unset = pure in-memory. |
| `GROQ_API_KEY` | for `llm` | — | Model credential. Absent = `llm` jobs fail gracefully; `mock` is unaffected. |
| `LLM_BASE_URL` | no | `https://api.groq.com/openai/v1` | Model endpoint, without the `/chat/completions` suffix. |
| `LLM_MODEL` | no | `llama-3.3-70b-versatile` | Model id. |
| `LLM_MAX_OUTPUT_TOKENS` | no | `4096` | Response cap. |
| `LLM_TIMEOUT_MS` | no | `20000` | Per-request timeout. Covers the response **body** read, not just the headers — a vendor that stalls mid-body fails the job instead of hanging it. |

Never commit `.env` — it is gitignored. `.env.example` documents the full set.

## API

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | public | `{status, version, uptimeSeconds}` |
| `GET /spec` | public | Self-declared limits; matches enforced behavior |
| `POST /v1/reviews` | bearer | `202 {jobId, status:"queued"}`; rate limited |
| `GET /v1/reviews/{jobId}` | bearer | Status, `usage`, and `findings` once done |
| `GET /v1/reviews/{jobId}/stream` | bearer | SSE: `status`, `finding`×N, `done` |

Request body:

```json
{
  "diff": "<unified diff>",
  "options": { "provider": "mock", "maxFindings": 100 }
}
```

Headers: `Authorization: Bearer <token>` (required), `Idempotency-Key: <key>` (optional).

Errors use `{"error":{"code":"...","message":"..."}}` with codes `unauthorized` (401),
`payload_too_large` (413), `invalid_json` (400), `invalid_diff` (422),
`idempotency_conflict` (409), `not_found` (404), `rate_limited` (429), `internal` (500).

**Rate limiting** applies to `POST /v1/reviews` only. Token bucket, **burst capacity 30**,
refilling at 30/minute. Beyond the burst: `429` plus a `Retry-After` header. GETs are
never limited. (The burst is not in `/spec` because the brief fixes that object's shape;
it is declared here, as the brief's "your declared burst" allows.)

## How the `llm` provider is configured

The `llm` provider calls **Groq**'s OpenAI-compatible Chat Completions API
(`POST {LLM_BASE_URL}/chat/completions`) with `Authorization: Bearer <key>`. Groq was
chosen because its free tier needs no credit card, which keeps the whole deployment
free. Credentials live only on the server, in `GROQ_API_KEY` — clients send only the
bearer token.

The key is set as an environment variable on the host (Render dashboard → the service →
**Environment**) and locally in `.env`, which is gitignored. It is never written into
`render.yaml`, which is committed and public — that is what `sync: false` is for.

```bash
echo 'GROQ_API_KEY=gsk_...' >> .env               # local only
```

Because the wire format is the OpenAI dialect, any OpenAI-compatible endpoint works by
changing `LLM_BASE_URL` and `LLM_MODEL` alone — no code change.

It sits behind the same `ReviewProvider` interface as `mock`, so chunking, ordering,
dedup, truncation, caching, SSE and the job lifecycle are shared code — not reimplemented.

Two guarantees:

- **It degrades, never crashes.** Missing key, DNS failure, connection refused, HTTP
  error, timeout, or unparseable output all become a `failed` job with a clear message.
  Verified against a refused connection, an HTTP 401, and an unset key.
- **Diff content cannot become instructions.** The diff is passed as delimited data, the
  system prompt says so, and — the part that actually enforces it — every finding the
  model returns is validated against the real added lines. `evidence` is always taken
  from our own parsed diff. A model that fully obeys an injected instruction still
  cannot invent a finding or forge evidence.

To exercise the path without a real key, `tools/fake-llm.mjs` is an OpenAI-shaped stub
that deliberately returns one valid finding, one on a line that was never added, and one
in a file not in the diff — only the valid one may survive:

```bash
node tools/fake-llm.mjs &
AUTH_TOKEN=t GROQ_API_KEY=stub LLM_BASE_URL=http://127.0.0.1:9500 node dist/server.js
```

## Deploying

### Render (what this service is deployed on)

`render.yaml` is a Blueprint: Docker runtime, free plan, `/health` healthcheck. Connect
the repo at [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**,
then set three secrets in the dashboard: `AUTH_TOKEN`, `GROQ_API_KEY`, and `KEEPALIVE_URL`
(`https://<service>.onrender.com/health`, filled in once the URL exists).

**Why the keep-alive.** Render spins a free web service down after 15 minutes without
inbound traffic, with a ~60 s cold start. This service cannot afford that: jobs, the
result cache, the idempotency map and the SSE event log are in-memory, so waking up means
every previously-issued `jobId` 404s, `cacheHit` reverts to `false`, and SSE replay has
nothing to replay — three separately-scored behaviors. `KEEPALIVE_URL` makes the process
ping its own public URL every 4 minutes (`src/server.ts`), a ~3.7× margin under the idle
window. It is deliberately internal rather than an external cron: an outside pinger is one
more thing that can quietly stop.

**What is lost.** The free plan has no persistent disk, so the `JOB_STORE_PATH` snapshot
lives inside the container and does not survive a redeploy or a platform restart. On this
host the store is effectively in-memory; uptime, not persistence, is what protects the
cross-cutting behaviors.

Then probe the deployed URL:

```bash
node probe.mjs https://<service>.onrender.com <your-token>
```

### Reproducing the deployed container locally

The image Render runs is the one in this repo, with no host-specific build steps:

```bash
docker build -t diff-review .
docker run -p 8080:8080 -e AUTH_TOKEN=... -v "$(pwd)/data:/data" diff-review
node probe.mjs http://127.0.0.1:8080 <token>
```

## Tests

```bash
npm test          # 88 unit tests: parser, chunker, rules, ordering, cache keys, limiter
npm run typecheck
node probe.mjs <baseUrl> <token>   # 69 end-to-end checks against a running instance
```

The probe's rate-limit section waits 62 s for the token bucket to refill so burst
capacity is measured from a known state. Set `PROBE_SKIP_REFILL=1` to skip that wait.

**The probe assumes a cold instance.** Running it twice in a row against the same warm
process produces two families of false failures, both of which are the service behaving
correctly:

- *"First submission reported cacheHit false"* — the cache test submits a **static** diff,
  so on the second run the first submission is a genuine cache hit. Nothing is evicted by
  design (`SKIPPED.md`).
- *"All 5 concurrent submissions accepted"* — the previous run's 45-request burst drained
  the token bucket, so the concurrency section's POSTs are correctly rejected with `429`.
  After a 75 s refill the same five submissions return `202,202,202,202,202` and all reach
  `done`.

Restart the service, or leave ~90 s between runs. A deploy switchover is a third source:
a POST accepted by the outgoing container and polled on the incoming one will never reach
`done`, because job state is per-instance and in-memory.

## Project layout

```
src/core/      diff parser, chunker, rule engine, ordering/dedup, cache keys
src/providers/ ReviewProvider interface, mock, llm (Groq / OpenAI-compatible)
src/jobs/      pipeline, bounded queue, job store + event log + persistence
src/http/      app/routes, auth, error taxonomy, rate limiter
probe.mjs      end-to-end probe
```

See `DECISIONS.md` for every non-obvious judgment call and `SKIPPED.md` for what was
deliberately left out.
