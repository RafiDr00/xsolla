import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, cacheKey, sha256 } from './canonical.js';

test('applies documented defaults: mock provider, maxFindings 100', () => {
  assert.deepEqual(normalizeOptions(undefined), { provider: 'mock', maxFindings: 100 });
  assert.deepEqual(normalizeOptions({}), { provider: 'mock', maxFindings: 100 });
});

test('accepts the two declared providers', () => {
  assert.equal(normalizeOptions({ provider: 'llm' }).provider, 'llm');
  assert.equal(normalizeOptions({ provider: 'mock' }).provider, 'mock');
});

test('falls back to defaults for unusable option values rather than erroring', () => {
  // The error taxonomy has no code for bad options, and the brief says unknown fields
  // are ignored - so unusable values degrade to the default instead of failing the job.
  assert.equal(normalizeOptions({ provider: 'MOCK' }).provider, 'mock');
  assert.equal(normalizeOptions({ provider: 42 }).provider, 'mock');
  assert.equal(normalizeOptions({ maxFindings: 'ten' }).maxFindings, 100);
  assert.equal(normalizeOptions({ maxFindings: -5 }).maxFindings, 100);
  assert.equal(normalizeOptions({ maxFindings: 1.5 }).maxFindings, 100);
});

test('keeps maxFindings 0 as a meaningful value', () => {
  assert.equal(normalizeOptions({ maxFindings: 0 }).maxFindings, 0);
});

test('ignores unknown option fields', () => {
  assert.deepEqual(normalizeOptions({ provider: 'mock', wat: true, deep: { a: 1 } }), {
    provider: 'mock',
    maxFindings: 100,
  });
});

test('identical {diff, options} produce the same cache key', () => {
  const a = cacheKey('DIFF', { provider: 'mock', maxFindings: 100 });
  const b = cacheKey('DIFF', { provider: 'mock', maxFindings: 100 });

  assert.equal(a, b);
});

test('cache key is insensitive to how the caller spelled the defaults', () => {
  // `{}` and an explicit `{provider:"mock",maxFindings:100}` mean the same review, so
  // they must share a cache entry: normalization happens before hashing.
  const implicit = cacheKey('DIFF', normalizeOptions({}));
  const explicit = cacheKey('DIFF', normalizeOptions({ maxFindings: 100, provider: 'mock' }));

  assert.equal(implicit, explicit);
});

test('cache key changes with the diff, the provider, or maxFindings', () => {
  const base = cacheKey('DIFF', { provider: 'mock', maxFindings: 100 });

  assert.notEqual(base, cacheKey('DIFF2', { provider: 'mock', maxFindings: 100 }));
  assert.notEqual(base, cacheKey('DIFF', { provider: 'llm', maxFindings: 100 }));
  assert.notEqual(base, cacheKey('DIFF', { provider: 'mock', maxFindings: 10 }));
});

test('cache key is field-order independent', () => {
  // Guards against a JSON.stringify(obj) key that would vary with insertion order.
  const one = cacheKey('D', JSON.parse('{"provider":"mock","maxFindings":7}'));
  const two = cacheKey('D', JSON.parse('{"maxFindings":7,"provider":"mock"}'));

  assert.equal(one, two);
});

test('sha256 is stable and hex encoded', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('sha256 hashes bytes, so identical bytes hash identically', () => {
  assert.equal(sha256(Buffer.from('abc', 'utf8')), sha256('abc'));
});
