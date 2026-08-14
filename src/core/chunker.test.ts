import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkFiles, CHUNK_BUDGET_BYTES } from './chunker.js';
import type { DiffFile } from './diff.js';

/** Build a DiffFile of an exact byte size without going through the parser. */
function file(path: string, bytes: number): DiffFile {
  return { path, raw: 'x'.repeat(bytes), bytes, addedLines: [] };
}

test('the budget is 64 KiB', () => {
  assert.equal(CHUNK_BUDGET_BYTES, 64 * 1024);
});

test('files that fit together produce a single chunk', () => {
  const chunks = chunkFiles([file('a', 100), file('b', 200), file('c', 300)]);

  assert.equal(chunks.length, 1);
  assert.deepEqual(
    chunks[0]!.files.map((f) => f.path),
    ['a', 'b', 'c'],
  );
  assert.equal(chunks[0]!.bytes, 600);
});

test('splits on a file boundary rather than exceeding the budget', () => {
  const half = CHUNK_BUDGET_BYTES / 2;
  // 3 x 32 KiB: the first two fill the budget exactly, the third opens a new chunk.
  const chunks = chunkFiles([file('a', half), file('b', half), file('c', half)]);

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((c) => c.files.map((f) => f.path)),
    [['a', 'b'], ['c']],
  );
});

test('a file larger than the budget becomes its own chunk and is never split', () => {
  const huge = file('huge', CHUNK_BUDGET_BYTES + 1);
  const chunks = chunkFiles([file('small', 10), huge, file('after', 10)]);

  assert.deepEqual(
    chunks.map((c) => c.files.map((f) => f.path)),
    [['small'], ['huge'], ['after']],
  );
  // the oversized file survives intact - byte-for-byte
  assert.equal(chunks[1]!.files.length, 1);
  assert.equal(chunks[1]!.files[0]!.bytes, CHUNK_BUDGET_BYTES + 1);
});

test('two consecutive oversized files get one chunk each', () => {
  const chunks = chunkFiles([
    file('big1', CHUNK_BUDGET_BYTES * 2),
    file('big2', CHUNK_BUDGET_BYTES * 3),
  ]);

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((c) => c.files.map((f) => f.path)),
    [['big1'], ['big2']],
  );
});

test('a file exactly at the budget still fits in one chunk alone', () => {
  const chunks = chunkFiles([file('exact', CHUNK_BUDGET_BYTES)]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.files.length, 1);
});

test('file order is preserved across chunks', () => {
  const files = Array.from({ length: 10 }, (_, i) => file(`f${i}`, 20 * 1024));

  const flattened = chunkFiles(files).flatMap((c) => c.files.map((f) => f.path));

  assert.deepEqual(
    flattened,
    files.map((f) => f.path),
  );
});

test('every input file appears exactly once across all chunks', () => {
  const files = [
    file('a', 30 * 1024),
    file('b', CHUNK_BUDGET_BYTES + 5),
    file('c', 40 * 1024),
    file('d', 1),
  ];

  const flattened = chunkFiles(files).flatMap((c) => c.files);

  assert.equal(flattened.length, files.length);
  assert.deepEqual(new Set(flattened.map((f) => f.path)).size, files.length);
});

test('an empty file list produces no chunks', () => {
  assert.deepEqual(chunkFiles([]), []);
});

test('chunk byte totals equal the sum of their files', () => {
  const files = [file('a', 30 * 1024), file('b', 40 * 1024), file('c', 5 * 1024)];

  for (const chunk of chunkFiles(files)) {
    assert.equal(
      chunk.bytes,
      chunk.files.reduce((n, f) => n + f.bytes, 0),
    );
  }
});
