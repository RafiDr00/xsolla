import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './ratelimit.js';

/** Controllable clock so the tests never sleep. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceSeconds: (s: number) => {
      now += s * 1000;
    },
  };
}

test('the full burst is allowed immediately', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 30, refillPerMinute: 30, now: c.now });

  for (let i = 0; i < 30; i++) {
    assert.equal(limiter.check('t').allowed, true, `request ${i + 1} should pass`);
  }
});

test('the request beyond the burst is denied with a positive Retry-After', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 30, refillPerMinute: 30, now: c.now });
  for (let i = 0; i < 30; i++) limiter.check('t');

  const result = limiter.check('t');

  assert.equal(result.allowed, false);
  assert.ok(result.retryAfterSeconds >= 1, 'Retry-After must be a whole second or more');
  assert.equal(Number.isInteger(result.retryAfterSeconds), true);
});

test('a denied request does not consume a token (no starvation)', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60, now: c.now });
  limiter.check('t');
  limiter.check('t');

  limiter.check('t'); // denied
  limiter.check('t'); // denied
  c.advanceSeconds(1); // exactly one token refilled at 60/min

  assert.equal(limiter.check('t').allowed, true);
});

test('sustained 30 requests per minute all succeed', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 30, refillPerMinute: 30, now: c.now });

  // 30 requests spread evenly across a minute, for two minutes straight.
  for (let i = 0; i < 60; i++) {
    assert.equal(limiter.check('t').allowed, true, `sustained request ${i + 1}`);
    c.advanceSeconds(2);
  }
});

test('tokens refill up to the cap but never beyond it', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 30, refillPerMinute: 30, now: c.now });
  for (let i = 0; i < 30; i++) limiter.check('t');

  c.advanceSeconds(600); // ten idle minutes

  for (let i = 0; i < 30; i++) {
    assert.equal(limiter.check('t').allowed, true, `post-idle request ${i + 1}`);
  }
  assert.equal(limiter.check('t').allowed, false, 'bucket must cap at the burst size');
});

test('buckets are per key, so one caller cannot exhaust another', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 1, refillPerMinute: 30, now: c.now });

  assert.equal(limiter.check('alice').allowed, true);
  assert.equal(limiter.check('alice').allowed, false);
  assert.equal(limiter.check('bob').allowed, true);
});
