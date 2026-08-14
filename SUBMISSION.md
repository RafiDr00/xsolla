# Submission

**Base URL:** `[ME: https://<your-app>.fly.dev]`
**Bearer token:** `[ME: the token you set as AUTH_TOKEN — send this to the graders]`
**Repository:** `[ME: your repo URL]`

---

## Architecture

Node 22 + TypeScript + Express 5, with exactly one production dependency (`express`);
hashing, HTTP client and test runner all come from the standard library.

A request flows: **auth → rate limit (POST only) → raw-body read with a 1 MiB cap → JSON
parse → diff parse + chunk → idempotency → cache → job**. Parsing happens *before* the
202, so an unparseable diff is a `422` rather than a failed job, and `usage.inputBytes`
and `usage.chunks` are accurate from the moment the job is queued.

A bounded queue (4 workers) runs jobs; the pipeline scans each chunk through a
`ReviewProvider`, merges the results, then sorts by (path, line, ruleId) **once,
globally**, deduplicates by `id`, and truncates to `maxFindings`. Every observable
transition is appended to a per-job event log; SSE clients replay that log and then tail
it, which is why replay on a finished job is identical to the live stream by construction
rather than by a second code path. State is in-memory with a debounced, atomically-renamed
disk snapshot so a restart inside the scoring window does not lose finished jobs.

## Provider design

`ReviewProvider` is deliberately narrow — `review(chunk) => Promise<Finding[]>`. A
provider does not sort, deduplicate, truncate, cache, or know that chunking exists; all
of that is pipeline responsibility. That single seam is why the `llm` provider inherits
every cross-cutting behavior from `mock` without reimplementing any of it.

`mock` applies the rule table to added lines and is fully deterministic. `llm` calls the
Anthropic Messages API with server-side credentials. Two properties matter more than its
review quality:

- **It degrades, it never crashes.** Missing key, connection refused, HTTP error, timeout
  and unparseable output all become a `failed` job with a clear message. Node's `fetch`
  reports every transport failure as a bare `TypeError: fetch failed`, so the `.cause`
  chain is unwrapped to produce e.g. `LLM request to http://127.0.0.1:9099 failed: fetch
  failed: connect ECONNREFUSED 127.0.0.1:9099`.
- **Diff content can never act as instructions.** The diff is delivered as delimited data
  and the system prompt says so — but the actual enforcement is that every returned
  finding is validated against the real added lines, and `evidence` is always taken from
  our own parsed diff. A model that fully obeys an injected instruction still cannot
  invent a finding or forge evidence.

## How I verified the cross-cutting behaviors

Two layers: **88 unit tests** (`npm test`) over the pure logic, and **69 end-to-end
checks** (`node probe.mjs <url> <token>`) against a running instance. Final local run:
**69 passed, 0 failed**.

**Chunking.** The unit suite builds a >64 KiB multi-file diff, runs it through the real
chunked pipeline, and asserts the result is `deepEqual` *and* `JSON.stringify`-identical
to a single unchunked `scanFiles` over the same files — so "identical to an unchunked
scan" is asserted directly, not inferred. Separate tests cover the invariants that make
that true: split only on file boundaries, a file ≥64 KiB becomes its own chunk unsplit,
order preserved, every file appearing exactly once. End to end, a 312,599-byte 6-file
diff reported `usage.chunks: 6`, returned all 26 expected findings with no duplicate ids
and correct ordering across boundaries, including the finding inside the single
oversized file.

**Caching.** Two byte-identical submissions: the first reports `cacheHit: false`, the
second `cacheHit: true`, and their findings arrays are compared with `JSON.stringify` for
byte-identity. Cache keys are normalised before hashing, so `{}` and an explicit
`{"provider":"mock","maxFindings":100}` share an entry — unit-tested.

**Idempotency.** Same key + identical body returns the *same* `jobId`; same key +
different body returns `409 idempotency_conflict`. The hash is over the raw request bytes,
because the contract defines idempotency on a byte-identical body.

**SSE replay.** Streaming a finished job twice is asserted **byte-identical**, and a
stream attached *before* completion is asserted to produce the same event sequence as a
later replay. The `done` event carries `{total, usage}`. Replay was also verified to work
after a genuine process restart (47 jobs restored from snapshot, event log intact).

**Rate limiting.** The probe's own earlier POSTs drain the bucket, so the burst section
first waits 62 s for a full refill, then fires 45 concurrent POSTs: exactly **30 accepted,
15 × 429, 0 × 5xx**, with `Retry-After` present and code `rate_limited`. GETs return 404
both before and after the burst, never 429. The token-bucket refill logic (including
sustained 30/min across two simulated minutes) is unit-tested against an injected clock.

**Rules and injection inertness.** A crafted diff triggers all nine rules exactly once
each, in contract order, with `MOCK-004` reported on the `catch` line and `MOCK-INJ`
reported as a finding while the other eight rules still fire on the same scan.

**Graceful LLM degradation** was proven by simulating outages, not by assertion: a
refused connection, an HTTP 401 from a stub endpoint, and an unset key each produced a
`failed` job with a clear error while `/health` stayed 200 and `mock` jobs kept working
on the same instance. The success path was proven against an Anthropic-shaped stub that
deliberately returned one valid finding, one on a line that was never added, and one in a
file not in the diff — only the valid one survived.

## AI tools used

[ME: describe honestly which AI tools you used and how — e.g. which parts you drove
yourself, which you delegated, how you reviewed the output. Do not let anyone else write
this paragraph for you; the interviewers will ask follow-ups.]

## An AI suggestion I rejected

[ME: this must be your own words and your own example. Some candidate moments from this
build you may or may not want to draw on — only use one if it genuinely reflects your
judgment:

 - the `== null` substring question (a literal reading also matches `!== null` and
   `=== null`; we went with loose-operators-only and documented why in DECISIONS #3);
 - whether a comment-only catch body counts as empty (we followed ESLint `no-empty`
   rather than the broader reading — DECISIONS #4);
 - emitting SSE `finding` events as each chunk finished, which is what "as discovered"
   suggests but which breaks the required global ordering (DECISIONS #8);
 - publishing the rate-limit burst inside `/spec.limits`, which risks failing a strict
   schema comparison against the brief's fixed shape (DECISIONS #15).

Write up whichever one you actually made a call on, in your own voice, including what you
would have lost by accepting it.]

## What I'd do next with more time

1. **Shared state.** Move jobs, cache, idempotency records and the rate limiter into
   Redis so the service scales past one instance. Today it is deliberately pinned to a
   single always-on machine (`SKIPPED.md`).
2. **Eviction.** LRU + size cap on the cache, TTL sweep on finished jobs. Nothing is
   evicted today, which is bounded for a 96-hour window and a leak beyond it.
3. **Sharpen MOCK-003.** The current detector is lexical. A real tokeniser would catch
   multi-line and template-literal query construction and drop the `"SELECT" + " prose"`
   false positive.
4. **Observability.** Structured logs with a request id, plus metrics for queue depth,
   job latency percentiles, cache hit rate and provider error rate — the four numbers I
   would actually want on a dashboard for this service.
5. **Harden the `llm` path.** Retry with backoff on 429/5xx from the vendor, per-chunk
   concurrency with a cap, and a few-shot prompt evaluated against a fixture set so its
   output quality is measurable rather than assumed.

[ME: adjust this list so it reflects what *you* would prioritise — you will be asked why
these five and not others.]
