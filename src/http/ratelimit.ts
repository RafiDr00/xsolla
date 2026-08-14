/**
 * Token-bucket rate limiter for POST /v1/reviews.
 *
 * Bucket per key (the bearer token), capacity = burst, refilled continuously at
 * `refillPerMinute`. Continuous refill rather than a fixed window is what makes
 * "sustained 30/min must succeed" hold at any phase: a fixed window would reject a
 * caller who straddles a window boundary while still averaging 30/min.
 *
 * A denied request consumes nothing, so a client hammering the endpoint cannot starve
 * itself past the advertised recovery time.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until one token is available. Sent as the Retry-After header. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterOptions {
  capacity: number;
  refillPerMinute: number;
  /** Injectable clock - keeps the tests instant and deterministic. */
  now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly tokensPerMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.tokensPerMs = options.refillPerMinute / 60_000;
    this.now = options.now ?? Date.now;
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: now };

    const elapsed = now - bucket.lastRefillMs;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.tokensPerMs);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.buckets.set(key, bucket);
    const msUntilToken = (1 - bucket.tokens) / this.tokensPerMs;
    return {
      allowed: false,
      // Always at least 1: a Retry-After of 0 invites an immediate retry that would also
      // be denied.
      retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1000)),
    };
  }
}
