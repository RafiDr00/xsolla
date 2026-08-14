import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from './diff.js';

/**
 * The parser's single job: turn a unified diff into (path, new-file line number, content)
 * for ADDED lines only. Every rule in the engine is defined over added lines, so a
 * one-off error here silently corrupts every finding's `line`.
 */

test('extracts added lines with new-file line numbers, tracking the hunk header', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-const old = 0;',
    '+const b = 2;',
    '+const c = 3;',
    ' const d = 4;',
    ' const e = 5;',
    '',
  ].join('\n');

  const files = parseUnifiedDiff(diff);

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, 'src/app.js');
  assert.deepEqual(files[0]!.addedLines, [
    { path: 'src/app.js', line: 2, content: 'const b = 2;' },
    { path: 'src/app.js', line: 3, content: 'const c = 3;' },
  ]);
});

test('never treats the +++ header as an added line', () => {
  const diff = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1,2 @@',
    ' keep',
    '+added',
    '',
  ].join('\n');

  const added = parseUnifiedDiff(diff)[0]!.addedLines;

  assert.equal(added.length, 1);
  assert.equal(added[0]!.content, 'added');
  assert.equal(added[0]!.line, 2);
});

test('deleted lines advance the old file only, not the new line counter', () => {
  const diff = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,4 +1,2 @@',
    ' one',
    '-two',
    '-three',
    '+TWO',
    '',
  ].join('\n');

  // new file is: one(1), TWO(2)  -> the two deletions must not push TWO to line 4
  assert.deepEqual(parseUnifiedDiff(diff)[0]!.addedLines, [
    { path: 'a.txt', line: 2, content: 'TWO' },
  ]);
});

test('resets the line counter at each hunk header', () => {
  const diff = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' a',
    '+b',
    ' c',
    '@@ -20,2 +21,3 @@',
    ' x',
    '+y',
    ' z',
    '',
  ].join('\n');

  assert.deepEqual(parseUnifiedDiff(diff)[0]!.addedLines, [
    { path: 'a.txt', line: 2, content: 'b' },
    { path: 'a.txt', line: 22, content: 'y' },
  ]);
});

test('handles a hunk header with an omitted line count (@@ -1 +1 @@)', () => {
  const diff = ['--- a/a.txt', '+++ b/a.txt', '@@ -1 +7 @@', '+only', ''].join('\n');

  assert.deepEqual(parseUnifiedDiff(diff)[0]!.addedLines, [
    { path: 'a.txt', line: 7, content: 'only' },
  ]);
});

test('splits multiple files and keeps them in diff order', () => {
  const diff = [
    'diff --git a/z.js b/z.js',
    '--- a/z.js',
    '+++ b/z.js',
    '@@ -0,0 +1 @@',
    '+first',
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -0,0 +1 @@',
    '+second',
    '',
  ].join('\n');

  const files = parseUnifiedDiff(diff);

  assert.deepEqual(
    files.map((f) => f.path),
    ['z.js', 'a.js'],
  );
  assert.equal(files[0]!.addedLines[0]!.content, 'first');
  assert.equal(files[1]!.addedLines[0]!.content, 'second');
});

test('treats a new file (--- /dev/null) as ordinary additions', () => {
  const diff = [
    'diff --git a/new.py b/new.py',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.py',
    '@@ -0,0 +1,2 @@',
    '+import os',
    '+print(os)',
    '',
  ].join('\n');

  const file = parseUnifiedDiff(diff)[0]!;

  assert.equal(file.path, 'new.py');
  assert.deepEqual(
    file.addedLines.map((l) => l.line),
    [1, 2],
  );
});

test('a deleted file (+++ /dev/null) yields no added lines and keeps the old path', () => {
  const diff = [
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-was here',
    '-and here',
    '',
  ].join('\n');

  const file = parseUnifiedDiff(diff)[0]!;

  assert.equal(file.path, 'gone.js');
  assert.deepEqual(file.addedLines, []);
});

test('ignores the "\\ No newline at end of file" marker', () => {
  const diff = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  assert.deepEqual(parseUnifiedDiff(diff)[0]!.addedLines, [
    { path: 'a.txt', line: 1, content: 'new' },
  ]);
});

test('tolerates CRLF line endings', () => {
  const diff = ['--- a/a.txt', '+++ b/a.txt', '@@ -0,0 +1 @@', '+added', ''].join('\r\n');

  assert.deepEqual(parseUnifiedDiff(diff)[0]!.addedLines, [
    { path: 'a.txt', line: 1, content: 'added' },
  ]);
});

test('records the byte length of each file section for the chunker', () => {
  const diff = ['--- a/a.txt', '+++ b/a.txt', '@@ -0,0 +1 @@', '+hello', ''].join('\n');

  const file = parseUnifiedDiff(diff)[0]!;

  assert.equal(file.bytes, Buffer.byteLength(file.raw, 'utf8'));
  assert.ok(file.raw.includes('+hello'));
});

test('counts bytes, not UTF-16 code units, for multi-byte content', () => {
  const diff = ['--- a/a.txt', '+++ b/a.txt', '@@ -0,0 +1 @@', '+héllo — 🚀', ''].join('\n');

  const file = parseUnifiedDiff(diff)[0]!;

  assert.equal(file.bytes, Buffer.byteLength(file.raw, 'utf8'));
  assert.ok(file.bytes > file.raw.length);
});

test('never throws on malformed input: garbage yields no files', () => {
  assert.deepEqual(parseUnifiedDiff('this is not a diff at all\njust prose\n'), []);
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('never throws when a hunk body appears before any file header', () => {
  const diff = ['@@ -1,2 +1,3 @@', '+orphan', ''].join('\n');

  assert.deepEqual(parseUnifiedDiff(diff), []);
});
