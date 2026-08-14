import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { LIMITS, RATE_LIMIT_BURST, SPEC_VERSION, VERSION, type Config } from '../config.js';
import { cacheKey, normalizeOptions, sha256 } from '../core/canonical.js';
import { ApiError, envelope, type ErrorCode } from './errors.js';
import { RateLimiter } from './ratelimit.js';
import { JobQueue } from '../jobs/queue.js';
import { JobStore, isTerminal, type Job, type JobEvent } from '../jobs/store.js';
import { prepareDiff, runReview } from '../jobs/pipeline.js';
import { createProviders } from '../providers/index.js';

const STARTED_AT = Date.now();

/** Constant-time bearer comparison over digests, so length never leaks either. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Reads the raw request body with a hard byte cap.
 *
 * Raw bytes (not a re-serialized object) because idempotency is defined on a
 * byte-identical body, so the hash must be over exactly what the client sent.
 */
function readRawBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let overLimit = false;

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        overLimit = true;
        // Keep draining rather than destroying the socket immediately: the client needs
        // to finish sending before it will read our 413. A second, much larger cap stops
        // that from becoming a memory sink.
        if (received > limit * 8) {
          req.destroy();
          reject(new ApiError('payload_too_large', `Request body exceeds ${limit} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overLimit) {
        reject(new ApiError('payload_too_large', `Request body exceeds ${limit} bytes`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => reject(error));
  });
}

/** Express 5 types a route param as string | string[]; we only ever want the scalar. */
function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** SSE wire format. One formatter, used for both live events and replay. */
function formatEvent(event: JobEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function createApp(config: Config): express.Express {
  const app = express();
  app.disable('x-powered-by');

  const store = new JobStore(config.jobStorePath);
  const queue = new JobQueue(LIMITS.maxConcurrentJobs);
  const providers = createProviders(config);
  const limiter = new RateLimiter({
    capacity: RATE_LIMIT_BURST,
    refillPerMinute: LIMITS.rateLimitPerMinute,
  });

  const fail = (res: Response, code: ErrorCode, message: string, headers: Record<string, string> = {}): void => {
    const error = new ApiError(code, message, headers);
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
    res.status(error.status).json(envelope(error.code, error.message));
  };

  // ------------------------------------------------------------- public routes

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });

  app.get('/spec', (_req, res) => {
    // Every number here is read from the same constants the enforcement code uses, so
    // the declaration cannot drift from actual behavior.
    res.json({
      specVersion: SPEC_VERSION,
      providers: ['mock', 'llm'],
      limits: {
        maxPayloadBytes: LIMITS.maxPayloadBytes,
        chunkBytes: LIMITS.chunkBytes,
        maxConcurrentJobs: LIMITS.maxConcurrentJobs,
        rateLimitPerMinute: LIMITS.rateLimitPerMinute,
      },
    });
  });

  // ------------------------------------------------------------- auth on ALL /v1

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    // RFC 7235: the auth scheme is case-insensitive. The token itself is not.
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match || !tokenMatches(match[1]!, config.authToken)) {
      fail(res, 'unauthorized', 'Missing or invalid bearer token');
      return;
    }
    next();
  });

  // ------------------------------------------------------------- job execution

  /** Runs a job to completion, converting any failure into a `failed` job. */
  function process(job: Job, diff: string, providerName: 'mock' | 'llm', maxFindings: number, key: string): void {
    queue.submit(async () => {
      store.setRunning(job);
      try {
        const prepared = prepareDiff(diff);
        if (!prepared) {
          store.fail(job, 'Diff could not be parsed as a unified diff');
          return;
        }
        const result = await runReview(prepared, providers[providerName], maxFindings);
        store.putCached(key, result);
        store.complete(job, result.findings);
      } catch (error) {
        // Includes every ProviderError from the llm path: unreachable model, bad key,
        // timeout, malformed output. The service stays up; the job reports why.
        const message = error instanceof Error ? error.message : String(error);
        store.fail(job, message);
      }
    });
  }

  // ------------------------------------------------------------- POST /v1/reviews

  app.post('/v1/reviews', (req: Request, res: Response, next: NextFunction) => {
    // Rate limiting first: it is the cheapest check and must never be bypassed by a
    // large body. Keyed by bearer token, and applied on this route only - GETs are
    // registered below and never touch the limiter.
    const token = (/^Bearer (.+)$/i.exec(req.get('authorization') ?? '') ?? [])[1] ?? 'anonymous';
    const verdict = limiter.check(token);
    if (!verdict.allowed) {
      fail(res, 'rate_limited', 'Rate limit exceeded', {
        'Retry-After': String(verdict.retryAfterSeconds),
      });
      return;
    }

    readRawBody(req, LIMITS.maxPayloadBytes)
      .then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          fail(res, 'invalid_json', 'Request body is not valid JSON');
          return;
        }

        const body = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed
          : {}) as Record<string, unknown>;

        // --- idempotency ------------------------------------------------------
        // Evaluated BEFORE diff validation on purpose: "same key + different body" is a
        // 409 whatever the new body contains, so a reused key with a broken diff must not
        // be reported as a 422. A replayed key implies the original body already passed
        // validation, so returning its job here skips nothing.
        const idempotencyKey = req.get('idempotency-key');
        const bodyHash = sha256(raw);
        if (idempotencyKey) {
          const existing = store.getIdempotent(idempotencyKey);
          if (existing) {
            if (existing.bodyHash !== bodyHash) {
              fail(
                res,
                'idempotency_conflict',
                'Idempotency-Key was already used with a different request body',
              );
              return;
            }
            // Same key, byte-identical body: hand back the original job.
            res.status(202).json({ jobId: existing.jobId, status: 'queued' });
            return;
          }
        }

        const diff = body['diff'];
        if (typeof diff !== 'string' || diff.length === 0) {
          fail(res, 'invalid_diff', 'Field "diff" is required and must be a non-empty string');
          return;
        }

        // Parse now so an unparseable diff is a 422 rather than a failed job, and so
        // usage.chunks is accurate from the moment the job is queued.
        const prepared = prepareDiff(diff);
        if (!prepared) {
          fail(res, 'invalid_diff', 'Field "diff" is not parseable as a unified diff');
          return;
        }

        const options = normalizeOptions(body['options']);

        // --- cache ------------------------------------------------------------
        const key = cacheKey(diff, options);
        const cached = store.getCached(key);

        const job = store.create({
          inputBytes: prepared.inputBytes,
          chunks: prepared.chunks.length,
          cacheHit: cached !== undefined,
        });
        if (idempotencyKey) store.putIdempotent(idempotencyKey, bodyHash, job.jobId);

        if (cached) {
          // Do not redo the work, and do not occupy a worker slot either. Completing on
          // the next tick keeps the event sequence identical to a normally-run job.
          setImmediate(() => {
            store.setRunning(job);
            store.complete(job, cached.findings);
          });
        } else {
          process(job, diff, options.provider, options.maxFindings, key);
        }

        // The contract fixes this response shape, so it is always {jobId, queued};
        // the live status is available from GET immediately afterwards.
        res.status(202).json({ jobId: job.jobId, status: 'queued' });
      })
      .catch(next);
  });

  // ------------------------------------------------------------- GET /v1/reviews/:id

  app.get('/v1/reviews/:jobId', (req: Request, res: Response) => {
    const job = store.get(pathParam(req, 'jobId'));
    if (!job) {
      fail(res, 'not_found', 'Unknown jobId');
      return;
    }

    const payload: Record<string, unknown> = {
      jobId: job.jobId,
      status: job.status,
      usage: job.usage,
    };
    // findings only once there is a result to report.
    if (job.status === 'done') payload['findings'] = job.findings;
    // Not in the documented shape, but a failed job has to say why somewhere.
    if (job.status === 'failed' && job.error) payload['error'] = job.error;

    res.json(payload);
  });

  // ------------------------------------------------------------- SSE stream

  app.get('/v1/reviews/:jobId/stream', (req: Request, res: Response) => {
    const job = store.get(pathParam(req, 'jobId'));
    if (!job) {
      fail(res, 'not_found', 'Unknown jobId');
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats proxy buffering, which would otherwise hold events back.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Replay everything already recorded. For a finished job this is the entire stream,
    // byte-identical to what a live subscriber received, because both go through the
    // same event log and the same formatter.
    for (const event of job.events) res.write(formatEvent(event));

    if (isTerminal(job.status)) {
      res.end();
      return;
    }

    const unsubscribe = store.subscribe(job.jobId, (event) => {
      res.write(formatEvent(event));
      if (event.event === 'done') {
        unsubscribe();
        res.end();
      }
    });
    req.on('close', unsubscribe);
  });

  // ------------------------------------------------------------- fallbacks

  app.use((_req: Request, res: Response) => {
    fail(res, 'not_found', 'No such route');
  });

  // Four-arg signature is required for Express to treat this as an error handler.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
      res.status(error.status).json(envelope(error.code, error.message));
      return;
    }
    console.error('[http] unhandled error:', error);
    res.status(500).json(envelope('internal', 'Internal server error'));
  });

  return app;
}
