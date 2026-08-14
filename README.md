# AI Diff Review Service

Clients POST a unified diff with a bearer token; the service reviews it asynchronously
through a pluggable provider and returns structured findings over REST or SSE.

**Stack:** Node 22+ / TypeScript / Express 5. One production dependency (`express`);
everything else — hashing, HTTP client, test runner — is Node's standard library.

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
| `LLM_TIMEOUT_MS` | no | `20000` | Per-request timeout before the job fails. |

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

```bash
railway variables --set GROQ_API_KEY=gsk_...      # deployed
echo 'GROQ_API_KEY=gsk_...' >> .env               # local
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

### Fly.io (recommended)

```bash
fly launch --no-deploy          # or: fly apps create <name>, then edit fly.toml
fly volumes create review_data --size 1 --region cdg
fly secrets set AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly deploy
fly status
```

`fly.toml` pins `min_machines_running = 1` and `auto_stop_machines = 'off'` so the
machine never scales to zero — a host that sleeps on idle would cold-start mid-window and
drop in-memory job state, breaking SSE replay and cache hits. The mounted volume keeps
finished jobs across a redeploy.

Then probe the deployed URL:

```bash
node probe.mjs https://<app>.fly.dev <your-token>
```

### Any Docker host

```bash
docker build -t diff-review .
docker run -p 8080:8080 -e AUTH_TOKEN=... -v $(pwd)/data:/data diff-review
```

### Tunnel (fallback)

`cloudflared tunnel --url http://localhost:8080` works, but uptime then depends on the
laptop staying awake and online for the full window. Use only as a backup.

## Tests

```bash
npm test          # 88 unit tests: parser, chunker, rules, ordering, cache keys, limiter
npm run typecheck
node probe.mjs <baseUrl> <token>   # 69 end-to-end checks against a running instance
```

The probe's rate-limit section waits 62 s for the token bucket to refill so burst
capacity is measured from a known state. Set `PROBE_SKIP_REFILL=1` to skip that wait.

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
