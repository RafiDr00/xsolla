/**
 * Unified-diff parser.
 *
 * Scope is deliberately narrow: the rule engine only ever looks at ADDED lines, so all
 * this needs to produce is `(path, new-file line number, content)` triples plus enough
 * byte accounting for the chunker. It is a hand-rolled state machine rather than a
 * library because (a) it removes a dependency, and (b) the `line` semantics below are
 * the single easiest thing to get wrong in this task and I want them explicit.
 *
 * Never throws. Malformed input yields fewer files, not an exception - the service must
 * answer with a documented error, never a 500 from a parser crash.
 */

export interface AddedLine {
  /** Path of the file the line belongs to (new path, VCS prefix stripped). */
  path: string;
  /** 1-based line number in the NEW file. */
  line: number;
  /** Line content with the leading '+' marker removed. */
  content: string;
}

export interface DiffFile {
  path: string;
  /** The verbatim slice of the diff belonging to this file, headers included. */
  raw: string;
  /** UTF-8 byte length of `raw`. The chunker budgets on bytes, not characters. */
  bytes: number;
  addedLines: AddedLine[];
}

/** `@@ -oldStart[,oldCount] +newStart[,newCount] @@` - the counts are optional. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface Section {
  startIndex: number;
  path: string | null;
  oldPath: string | null;
  /** Set once `+++` is seen, which is how we detect the start of the *next* file. */
  sawNewFileHeader: boolean;
  inHunk: boolean;
  /** Line number in the new file that the next non-deleted line will occupy. */
  newLine: number;
  addedLines: AddedLine[];
}

/** Strips the `a/` or `b/` prefix git puts on paths; leaves other paths untouched. */
function stripVcsPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/** Takes the path out of a `--- ` / `+++ ` header, dropping any trailing timestamp. */
function headerPath(headerLine: string): string {
  const value = headerLine.slice(4).trim();
  // Some diff producers append a tab-separated timestamp: `a/file.c\t2024-01-01 ...`
  const tab = value.indexOf('\t');
  return tab === -1 ? value : value.slice(0, tab);
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text) return [];

  // Split on '\n' only, keeping any '\r' attached to the line, so that re-joining the
  // slices with '\n' reproduces the original bytes for CRLF input as well as LF.
  const rawLines = text.split('\n');
  const files: DiffFile[] = [];
  let current: Section | null = null;

  // Both helpers are pure w.r.t. `current`: the caller does the assignment. Mutating a
  // captured `let` from inside a closure defeats TypeScript's control-flow narrowing.
  const flush = (section: Section | null, endIndex: number): void => {
    if (!section) return;
    // A section without any resolvable path was never a real file header - drop it.
    const path = section.path ?? section.oldPath;
    if (path === null) return;
    const raw = rawLines.slice(section.startIndex, endIndex).join('\n') + '\n';
    files.push({
      path,
      raw,
      bytes: Buffer.byteLength(raw, 'utf8'),
      addedLines: section.addedLines,
    });
  };

  const openSection = (index: number): Section => ({
    startIndex: index,
    path: null,
    oldPath: null,
    sawNewFileHeader: false,
    inHunk: false,
    newLine: 0,
    addedLines: [],
  });

  for (let i = 0; i < rawLines.length; i++) {
    const withCr = rawLines[i]!;
    const line = withCr.endsWith('\r') ? withCr.slice(0, -1) : withCr;

    if (line.startsWith('diff --git ')) {
      flush(current, i);
      current = openSection(i);
      continue;
    }

    if (line.startsWith('--- ')) {
      // A second `---` after we've already seen a `+++` means a new file section began
      // without a `diff --git` header (plain `diff -u` output).
      if (!current || current.sawNewFileHeader) {
        flush(current, i);
        current = openSection(i);
      }
      const path = headerPath(line);
      current.oldPath = path === '/dev/null' ? null : stripVcsPrefix(path);
      current.inHunk = false;
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (!current) current = openSection(i);
      const path = headerPath(line);
      // For a deletion (`+++ /dev/null`) we keep the old path as the file's identity.
      current.path = path === '/dev/null' ? null : stripVcsPrefix(path);
      current.sawNewFileHeader = true;
      current.inHunk = false;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      // A hunk body before any file header is orphaned - ignore it rather than guessing.
      if (!current) continue;
      current.newLine = Number(hunk[2]);
      current.inHunk = true;
      continue;
    }

    if (!current || !current.inHunk) continue;

    const marker = line[0];
    if (marker === '+') {
      // The `+++` header is handled above, so anything reaching here is a real addition.
      current.addedLines.push({
        path: current.path ?? current.oldPath ?? '',
        line: current.newLine,
        content: line.slice(1),
      });
      current.newLine++;
    } else if (marker === '-') {
      // Deletion: exists in the old file only, so the new-file counter must NOT move.
    } else if (marker === '\\') {
      // "\ No newline at end of file" - metadata, belongs to neither file.
    } else if (marker === ' ' || line === '') {
      current.newLine++; // context line: present in both files
    } else {
      // Anything else ends the hunk body (e.g. a trailing `-- ` mail signature).
      current.inHunk = false;
    }
  }

  flush(current, rawLines.length);

  // `path` on each added line is filled in after the fact for sections where `+++`
  // arrived after some additions were buffered (never happens in valid diffs, but the
  // parser must not emit empty paths on malformed input).
  for (const file of files) {
    for (const added of file.addedLines) {
      if (added.path === '') added.path = file.path;
    }
  }

  return files;
}
