# What I skipped, and why

The brief invites prioritisation. Everything scored is implemented; this is what I chose
*not* to build, with the reasoning.

## Deliberately out of scope

**Multi-instance / shared state.** Job state, the cache, the idempotency map and the rate
limiter are all per-process. Two instances behind a load balancer would give inconsistent
cache hits and a per-instance rate limit. Fixing it means Redis, which is real
operational weight for a service that is scored as a single endpoint. Mitigated by
pinning the deployment to exactly one always-on machine (`min_machines_running = 1`).

**Cache and job eviction.** Nothing is ever evicted — no TTL, no LRU, no size cap. For a
scoring window with probe-scale traffic this is bounded and fine; for production it is a
slow memory leak. The fix is an LRU with a size cap on the cache and a TTL sweep on
finished jobs.

**Job cancellation.** No `DELETE /v1/reviews/{id}`. Not in the contract, and it
complicates the queue (in-flight tasks would need cooperative abort).

**Per-chunk parallelism within one job.** Chunks are reviewed sequentially. For `mock`
this is irrelevant (microseconds); for `llm` on a very large diff it is slower than it
could be. Sequential is deterministic and easier to reason about, and the 30 s budget
only applies to diffs ≤64 KiB, which are a single chunk.

**SSE reconnection semantics.** No `Last-Event-ID` handling, no heartbeat comments, no
`retry:` field. Replay-from-the-start is what the contract asks for and is strictly
simpler; a client that drops mid-stream can reconnect and get the whole log again.

**Structured logging, metrics, tracing.** `console.log` only. No request IDs, no
Prometheus endpoint. Right call for a take-home; the first thing I would add for
production.

**Rate limiting by IP as well as token.** Only the bearer token is keyed. All graders
share one token, so an IP dimension would add nothing here, and it is the wrong axis for
an API where the token *is* the identity.

**Streaming request parsing for very large bodies.** The whole body is buffered (capped
at 1 MiB, with a hard 8 MiB drain guard) before parsing. Fine at this limit; a service
accepting 100 MiB diffs would need to stream-parse.

## Considered and rejected

**A diff-parsing library.** Would have hidden exactly the line-numbering semantics the
task scores. See `DECISIONS.md` #2.

**Zod for request validation.** Adds a dependency to produce error shapes I then have to
map onto a fixed taxonomy anyway. Hand-rolled validation is ~30 lines and maps directly
to the required codes.

**Worker threads for the rule engine.** Genuine parallelism, but the mock scan is
microseconds per chunk — the serialisation cost would exceed the work. Yielding to the
event loop between chunks achieves the responsiveness that actually matters.

**Publishing the rate-limit burst in `/spec`.** The brief fixes that object's shape;
an extra key risks failing a strict schema comparison. Declared in the README instead.

## Known limits I would flag in review

- MOCK-003 is lexical, not a parse — see `DECISIONS.md` #5 for exactly what it misses and
  what it over-reports.
- MOCK-004 stays silent when a catch block's closing brace is not visible in the diff.
- The `llm` provider's review *quality* is untuned — a single-pass prompt with no
  few-shot examples. The task scores that the path exists, is safe, and degrades; not
  that it finds good bugs.
