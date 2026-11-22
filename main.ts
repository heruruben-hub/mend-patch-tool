// mend applies patches to a tree of text files, following the contract laid
// out in SPEC.md. AI tools emit their edits in four different shapes —
// unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit objects —
// so mend first works out which shape it was handed, then finds the lines
// each edit points at (they may have drifted in number or indentation since
// the patch was written) and finally rewrites the whole tree in one go, or
// leaves every file untouched when anything fails.
//
// Run it as `node main.ts [options] [PATCH]` under Node 22; nothing beyond
// the standard library is used.
//
// When MAKEFUN_ENV_URL is set the process is a graded trial rather than a
// CLI run: the tail of this file hands control to runner.ts. That hand-over
// block and runner.ts ship with the competition kit; they are not mend code.

import { readFileSync, writeFileSync, writeSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Two kinds of failure. A ParseAbort kills the run outright: one
// `error: ...` line and exit code 2. An EditAbort belongs to a single edit;
// run() gathers them and reports them together (section 2).
// ---------------------------------------------------------------------------

class ParseAbort {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class EditAbort {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function lineIsBlank(s: string): boolean {
  return s.trim() === '';
}

// Reading a patch (section 3): split on LF, drop one trailing CR from each
// line, and do not count the empty piece a final LF leaves behind.
function chopPatchLines(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const out: string[] = [];
  for (const piece of raw) out.push(piece.endsWith('\r') ? piece.slice(0, -1) : piece);
  return out;
}

// Section 3 calls a path safe when it is relative, contains no backslash,
// and has no segment that is empty, "." or "..".
function pathPassesCheck(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// How a file's text is held while edits work on it (section 3): its rows,
// the break it uses between them, and a flag for whether it ends with that
// break. viewOfText builds the view; textOfView flattens it back to bytes.
// ---------------------------------------------------------------------------

interface FileLines {
  rows: string[];
  breakStr: string;
  endsWithBreak: boolean;
}

function viewOfText(text: string): FileLines {
  if (text === '') return { rows: [], breakStr: '\n', endsWithBreak: false };
  const nlAt = text.indexOf('\n');
  const breakStr = nlAt > 0 && text[nlAt - 1] === '\r' ? '\r\n' : '\n';
  const rows = text.split(breakStr);
  const endsWithBreak = text.endsWith(breakStr);
  if (endsWithBreak) rows.pop();
  return { rows, breakStr, endsWithBreak };
}

function textOfView(view: FileLines): string {
  if (view.rows.length === 0) return '';
  const joined = view.rows.join(view.breakStr);
  return view.endsWithBreak ? joined + view.breakStr : joined;
}

// ---------------------------------------------------------------------------
// Matching lines at three strictness tiers (section 5). loosestTier caps
// how loose a search may go: 2 in normal runs, 0 under --strict. run()
// picks the value before the patch is parsed.
// ---------------------------------------------------------------------------

let loosestTier = 2;

function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimAllWs(s: string): string {
  const noLead = s.replace(/^[ \t]+/, '');
  return noLead.replace(/[ \t]+$/, '');
}

function leadWsOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function rowsAgreeAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimAllWs(a) === trimAllWs(b);
}

// All start positions, at or after `from`, where want matches rows in a row.
function findMatches(rows: string[], want: string[], tier: number, from: number): number[] {
  const starts: number[] = [];
  const lastStart = rows.length - want.length;
  for (let i = Math.max(0, from); i <= lastStart; i += 1) {
    if (want.every((w, k) => rowsAgreeAt(rows[i + k]!, w, tier))) starts.push(i);
  }
  return starts;
}

// The strictest tier at which want occurs at or after `from`, with every
// start there; null when it occurs at no tier up to the cap.
function bestTierHits(rows: string[], want: string[], from: number): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= loosestTier; tier += 1) {
    const at = findMatches(rows, want, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// The rows that take the place of the match at `at`. A context row (ctxIdx[k]
// holds its index into oldSeq) is taken verbatim from the file's own matched
// line; at tier 2 each remaining non-blank row is re-indented from oldSeq's
// first line's indentation to the file's (section 5).
function buildReplacement(fileRows: string[], at: number, oldSeq: string[], newSeq: string[], ctxIdx: (number | null)[], tier: number): string[] {
  const fileLead = leadWsOf(fileRows[at] ?? '');
  const patLead = leadWsOf(oldSeq[0] ?? '');
  const out: string[] = [];
  for (let k = 0; k < newSeq.length; k += 1) {
    const line = newSeq[k]!;
    const oi = ctxIdx[k];
    if (oi !== null && oi !== undefined) {
      out.push(fileRows[at + oi]!);
    } else if (tier === 2 && trimAllWs(line) !== '' && (patLead === '' || line.startsWith(patLead))) {
      out.push(fileLead + line.slice(patLead.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The state of the tree while edits run. `current` remembers what each edit
// decided for a path (null: the file is deleted); a path nobody has decided
// is read from disk on demand and cached in `untouched`. `moved` maps each
// move's new path back to its old one, which makeReport needs for the R row
// (section 2). The disk itself is only written once every edit has
// succeeded (section 10).
// ---------------------------------------------------------------------------

type EditStep = (tree: TreeState) => void;

class TreeState {
  private readonly untouched = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();
  readonly moved = new Map<string, string>();

  diskText(p: string): string | null {
    if (!this.untouched.has(p)) {
      let v: string | null = null;
      try {
        v = statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
      } catch {
        v = null;
      }
      this.untouched.set(p, v);
    }
    return this.untouched.get(p)!;
  }

  fetch(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.diskText(p);
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6). parseUnified makes a single pass over the
// patch collecting sections — a header block plus its hunks — and each
// section is then turned into one edit.
// ---------------------------------------------------------------------------

interface PatchRow {
  kind: 'ctx' | 'old' | 'new' | 'eol';
  content: string;
  /** The patch line was completely empty: an empty context row, or a separator after the body. */
  wasBlank: boolean;
}

interface PatchHunk {
  startLine: number;
  rows: PatchRow[];
}

interface PatchSection {
  headFrom: string | null;
  headTo: string | null;
  pathFrom: string | null;
  pathTo: string | null;
  fromNull: boolean;
  toNull: boolean;
  mvFrom: string | null;
  mvTo: string | null;
  isNewFile: boolean;
  isDelFile: boolean;
  hunkList: PatchHunk[];
}

function blankSection(): PatchSection {
  return { headFrom: null, headTo: null, pathFrom: null, pathTo: null, fromNull: false, toNull: false, mvFrom: null, mvTo: null, isNewFile: false, isDelFile: false, hunkList: [] };
}

// The path carried by a --- or +++ header line: whatever follows the
// four-character prefix, cut at the first tab and trimmed, with a leading
// a/ or b/ stripped; the literal /dev/null means that side has no file.
function headerPath(line: string): { path: string | null; isNull: boolean } {
  let raw = line.slice(4);
  const tabAt = raw.indexOf('\t');
  if (tabAt >= 0) raw = raw.slice(0, tabAt);
  raw = raw.trim();
  if (raw === '/dev/null') return { path: null, isNull: true };
  if (raw.startsWith('b/') || raw.startsWith('a/')) raw = raw.slice(2);
  return { path: raw, isNull: false };
}

function parseUnified(lines: string[]): EditStep[] {
  const sections: PatchSection[] = [];
  let cur: PatchSection | null = null;
  let inHeader = false;
  const pairHere = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      if (!line.startsWith('diff --git ')) throw new ParseAbort(`error: parse ${i + 1}`);
      const rest = line.slice(11);
      const sepPos = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sepPos < 0 || sepPos === 2 || sepPos + 3 >= rest.length) throw new ParseAbort(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.headFrom = rest.slice(2, sepPos);
      cur.headTo = rest.slice(sepPos + 3);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairHere(i)) {
      if (cur === null || !inHeader) {
        cur = blankSection();
        sections.push(cur);
        inHeader = true;
      }
      const fromH = headerPath(lines[i]!);
      const toH = headerPath(lines[i + 1]!);
      cur.pathFrom = fromH.path;
      cur.fromNull = fromH.isNull;
      cur.pathTo = toH.path;
      cur.toNull = toH.isNull;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // Inside a header, a --- line that no +++ line follows is a parse
      // fault; anywhere else such a line is just prose and is skipped.
      if (cur !== null && inHeader) throw new ParseAbort(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new ParseAbort(`error: parse ${i + 1}`);
      inHeader = false;
      const hk: PatchHunk = { startLine: Number(m[1]), rows: [] };
      cur.hunkList.push(hk);
      i += 1;
      while (i < lines.length) {
        const raw = lines[i]!;
        if (raw.startsWith('diff --git ') || pairHere(i)) break;
        const mark = raw[0];
        if (mark === ' ') hk.rows.push({ kind: 'ctx', content: raw.slice(1), wasBlank: raw.length === 1 });
        else if (mark === '-') hk.rows.push({ kind: 'old', content: raw.slice(1), wasBlank: false });
        else if (mark === '+') hk.rows.push({ kind: 'new', content: raw.slice(1), wasBlank: false });
        else if (mark === '\\') hk.rows.push({ kind: 'eol', content: '', wasBlank: false });
        else if (raw === '') hk.rows.push({ kind: 'ctx', content: '', wasBlank: true });
        else break;
        i += 1;
      }
      // Blank context rows at the end of a body separate it from whatever
      // follows; they are not content and are dropped.
      while (hk.rows.length > 0) {
        const tailRow = hk.rows[hk.rows.length - 1]!;
        if (tailRow.kind === 'ctx' && tailRow.wasBlank) hk.rows.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.mvFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.mvTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNewFile = true;
      else if (line.startsWith('deleted file mode')) cur.isDelFile = true;
      // index, mode, similarity and any other header lines mean nothing here.
      i += 1;
      continue;
    }
    // Lines outside headers and bodies are ignored (prose, code fences).
    i += 1;
  }
  return sections.map(sectionEdit);
}

// Runs one section's hunks, in order, over a file's text and returns the
// result. A hunk that cannot be placed fails the whole section with that
// hunk's fault.
function runHunks(srcText: string, hunkList: PatchHunk[], forPath: string): string {
  const fv = viewOfText(srcText);
  let rows = fv.rows;
  let tailBreak = fv.endsWithBreak;
  let delta = 0;
  for (const hk of hunkList) {
    const before: string[] = [];
    const after: string[] = [];
    const ctxIdx: (number | null)[] = [];
    for (const r of hk.rows) {
      if (r.kind === 'ctx') {
        before.push(r.content);
        after.push(r.content);
        ctxIdx.push(before.length - 1);
      } else if (r.kind === 'old') before.push(r.content);
      else if (r.kind === 'new') {
        after.push(r.content);
        ctxIdx.push(null);
      }
    }
    // When a `\` row directly follows the hunk's last context or + row, the
    // rewritten tail loses its final line break.
    let lastAfterAt = -1;
    hk.rows.forEach((r, k) => {
      if (r.kind === 'ctx' || r.kind === 'new') lastAfterAt = k;
    });
    const stripBreak = lastAfterAt >= 0 && hk.rows[lastAfterAt + 1]?.kind === 'eol';
    if (before.length === 0) {
      const pos = Math.min(hk.startLine + delta, rows.length);
      const atEnd = pos === rows.length;
      rows = [...rows.slice(0, pos), ...after, ...rows.slice(pos)];
      if (atEnd) tailBreak = !stripBreak;
      delta += after.length;
      continue;
    }
    const found = bestTierHits(rows, before, 0);
    if (found === null) throw new EditAbort('no-match', forPath);
    const aim = hk.startLine - 1 + delta;
    let pos = found.at[0]!;
    for (const cand of found.at) if (Math.abs(cand - aim) < Math.abs(pos - aim)) pos = cand;
    const replacement = buildReplacement(rows, pos, before, after, ctxIdx, found.tier);
    const reachesEnd = pos + before.length === rows.length;
    rows = [...rows.slice(0, pos), ...replacement, ...rows.slice(pos + before.length)];
    if (reachesEnd) tailBreak = !stripBreak;
    delta += after.length - before.length;
  }
  return textOfView({ rows, breakStr: fv.breakStr, endsWithBreak: tailBreak });
}

function sectionEdit(sec: PatchSection): EditStep {
  const fromPath = sec.pathFrom ?? sec.mvFrom ?? sec.headFrom;
  const toPath = sec.pathTo ?? sec.mvTo ?? sec.headTo;
  const creates = sec.fromNull || sec.isNewFile;
  const deletes = sec.toNull || sec.isDelFile;
  return (tree) => {
    if (creates) {
      const p = toPath ?? fromPath;
      if (p === null) throw new EditAbort('missing', '');
      if (!pathPassesCheck(p)) throw new EditAbort('unsafe', p);
      if (tree.fetch(p) !== null) throw new EditAbort('exists', p);
      const content: string[] = [];
      let lastPlusAt = -1;
      let flat = 0;
      let stripBreak = false;
      for (const hk of sec.hunkList) {
        for (const r of hk.rows) {
          if (r.kind === 'new') {
            content.push(r.content);
            lastPlusAt = flat;
            stripBreak = false;
          } else if (r.kind === 'eol' && flat === lastPlusAt + 1) stripBreak = true;
          flat += 1;
        }
      }
      tree.current.set(p, content.length === 0 ? '' : content.join('\n') + (stripBreak ? '' : '\n'));
      return;
    }
    if (deletes) {
      const p = fromPath ?? toPath;
      if (p === null) throw new EditAbort('missing', '');
      if (!pathPassesCheck(p)) throw new EditAbort('unsafe', p);
      if (tree.fetch(p) === null) throw new EditAbort('missing', p);
      tree.current.set(p, null);
      return;
    }
    if (fromPath !== null && toPath !== null && fromPath !== toPath) {
      // A move: the hunks rewrite the old file's text and the result is
      // stored at the new path instead; the old path is deleted, and the
      // move is recorded so the report folds the pair into one R row.
      if (!pathPassesCheck(fromPath)) throw new EditAbort('unsafe', fromPath);
      if (!pathPassesCheck(toPath)) throw new EditAbort('unsafe', toPath);
      const srcText = tree.fetch(fromPath);
      if (srcText === null) throw new EditAbort('missing', fromPath);
      if (tree.fetch(toPath) !== null) throw new EditAbort('exists', toPath);
      tree.current.set(toPath, runHunks(srcText, sec.hunkList, fromPath));
      tree.current.set(fromPath, null);
      tree.moved.set(toPath, fromPath);
      return;
    }
    const p = toPath ?? fromPath;
    if (p === null) throw new EditAbort('missing', '');
    if (!pathPassesCheck(p)) throw new EditAbort('unsafe', p);
    const srcText = tree.fetch(p);
    if (srcText === null) throw new EditAbort('missing', p);
    tree.current.set(p, runHunks(srcText, sec.hunkList, p));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7). The file a block belongs to is named
// on the nearest suitable line above its SEARCH marker; the block swaps
// one exact run of lines for another.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): EditStep[] {
  const steps: EditStep[] = [];
  let prevPath: string | null = null;
  let floor = 0;
  let i = 0;
  while (i < lines.length) {
    if (trimRightWs(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const startLine = i + 1;
    let eqPos = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (trimRightWs(lines[j]!) === '=======') {
        eqPos = j;
        break;
      }
    }
    if (eqPos < 0) throw new ParseAbort(`error: parse ${startLine}`);
    let rpPos = -1;
    for (let j = eqPos + 1; j < lines.length; j += 1) {
      if (trimRightWs(lines[j]!) === '>>>>>>> REPLACE') {
        rpPos = j;
        break;
      }
    }
    if (rpPos < 0) throw new ParseAbort(`error: parse ${startLine}`);
    // The block's path is the closest line above the SEARCH marker — but
    // not above the previous block — that is neither blank nor a code
    // fence; when there is no such line the previous block's path is kept.
    let filePath: string | null = null;
    for (let j = i - 1; j >= floor; j -= 1) {
      const txt = lines[j]!.trim();
      if (txt === '' || txt.startsWith('```')) continue;
      filePath = txt;
      break;
    }
    if (filePath === null) filePath = prevPath;
    if (filePath === null) throw new ParseAbort(`error: parse ${startLine}`);
    prevPath = filePath;
    steps.push(blockEdit(filePath, lines.slice(i + 1, eqPos), lines.slice(eqPos + 1, rpPos)));
    floor = rpPos + 1;
    i = rpPos + 1;
  }
  if (steps.length === 0) throw new ParseAbort('error: parse 1');
  return steps;
}

function blockEdit(filePath: string, before: string[], after: string[]): EditStep {
  return (tree) => {
    if (!pathPassesCheck(filePath)) throw new EditAbort('unsafe', filePath);
    if (before.length === 0) {
      // An empty SEARCH side means "create the file with these lines".
      if (tree.fetch(filePath) !== null) throw new EditAbort('exists', filePath);
      tree.current.set(filePath, after.length === 0 ? '' : after.join('\n') + '\n');
      return;
    }
    const srcText = tree.fetch(filePath);
    if (srcText === null) throw new EditAbort('missing', filePath);
    const fv = viewOfText(srcText);
    const found = bestTierHits(fv.rows, before, 0);
    if (found === null) throw new EditAbort('no-match', filePath);
    if (found.at.length > 1) throw new EditAbort('ambiguous', filePath);
    const pos = found.at[0]!;
    const replacement = buildReplacement(fv.rows, pos, before, after, after.map(() => null), found.tier);
    const joined = [...fv.rows.slice(0, pos), ...replacement, ...fv.rows.slice(pos + before.length)];
    tree.current.set(filePath, textOfView({ rows: joined, breakStr: fv.breakStr, endsWithBreak: fv.endsWithBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8): a Begin/End Patch frame holding Add, Delete and
// Update File sections. An update is a run of pieces applied in order
// against a cursor that only moves forward.
// ---------------------------------------------------------------------------

interface V4aLine {
  kind: 'ctx' | 'old' | 'new';
  content: string;
  /** The patch line was completely empty: an empty context row, or a separator after the section. */
  wasBlank: boolean;
}

interface V4aPiece {
  anchorText: string | null;
  rows: V4aLine[];
  atEof: boolean;
}

interface V4aPart {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  destPath: string | null;
  plusLines: { content: string; wasBlank: boolean }[];
  pieces: V4aPiece[];
}

function parseV4a(lines: string[]): EditStep[] {
  const headAt = lines.findIndex((l) => !lineIsBlank(l));
  if (headAt < 0) throw new ParseAbort('error: parse 1');
  if (lines[headAt]!.trim() !== '*** Begin Patch') throw new ParseAbort(`error: parse ${headAt + 1}`);
  let tailAt = lines.length - 1;
  while (tailAt > headAt && lineIsBlank(lines[tailAt]!)) tailAt -= 1;
  if (lines[tailAt]!.trim() !== '*** End Patch') throw new ParseAbort(`error: parse ${lines.length + 1}`);
  const parts: V4aPart[] = [];
  let cur: V4aPart | null = null;
  let piece: V4aPiece | null = null;
  // Blank context rows at the end of a piece separate it from what follows;
  // they are not content.
  const closePiece = (): void => {
    if (piece === null) return;
    while (piece.rows.length > 0) {
      const tailRow = piece.rows[piece.rows.length - 1]!;
      if (tailRow.kind === 'ctx' && tailRow.wasBlank) piece.rows.pop();
      else break;
    }
    piece = null;
  };
  const closePart = (): void => {
    if (cur === null) return;
    closePiece();
    if (cur.kind === 'add') {
      while (cur.plusLines.length > 0 && cur.plusLines[cur.plusLines.length - 1]!.wasBlank) cur.plusLines.pop();
    }
    parts.push(cur);
    cur = null;
  };
  for (let i = headAt + 1; i < tailAt; i += 1) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('*** Add File: ')) {
      closePart();
      cur = { kind: 'add', path: line.slice(14).trim(), atLine: ln, destPath: null, plusLines: [], pieces: [] };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closePart();
      cur = { kind: 'del', path: line.slice(17).trim(), atLine: ln, destPath: null, plusLines: [], pieces: [] };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closePart();
      cur = { kind: 'upd', path: line.slice(17).trim(), atLine: ln, destPath: null, plusLines: [], pieces: [] };
      continue;
    }
    if (cur === null) {
      if (lineIsBlank(line)) continue;
      throw new ParseAbort(`error: parse ${ln}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.plusLines.push({ content: line.slice(1), wasBlank: false });
      else if (line === '') cur.plusLines.push({ content: '', wasBlank: true });
      else throw new ParseAbort(`error: parse ${ln}`);
      continue;
    }
    if (cur.kind === 'del') throw new ParseAbort(`error: parse ${ln}`);
    // An Update File section: at most one Move to line first, then pieces.
    if (line === '*** End of File') {
      if (piece !== null) piece.atEof = true;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (cur.pieces.length === 0 && piece === null && cur.destPath === null) {
        cur.destPath = line.slice(13).trim();
        continue;
      }
      throw new ParseAbort(`error: parse ${ln}`);
    }
    if (line.startsWith('@@')) {
      closePiece();
      piece = { anchorText: line.slice(2).trim() || null, rows: [], atEof: false };
      cur.pieces.push(piece);
      continue;
    }
    const mark = line[0];
    if (mark === ' ' || mark === '-' || mark === '+' || line === '') {
      if (piece === null) {
        piece = { anchorText: null, rows: [], atEof: false };
        cur.pieces.push(piece);
      }
      if (line === '') piece.rows.push({ kind: 'ctx', content: '', wasBlank: true });
      else piece.rows.push({ kind: mark === ' ' ? 'ctx' : mark === '-' ? 'old' : 'new', content: line.slice(1), wasBlank: mark === ' ' && line.length === 1 });
      continue;
    }
    throw new ParseAbort(`error: parse ${ln}`);
  }
  closePart();
  for (const part of parts) {
    if (part.kind === 'upd' && part.pieces.length === 0 && part.destPath === null) throw new ParseAbort(`error: parse ${part.atLine}`);
  }
  if (parts.length === 0) throw new ParseAbort('error: parse 1');
  return parts.map(v4aPartEdit);
}

function v4aPartEdit(part: V4aPart): EditStep {
  return (tree) => {
    if (!pathPassesCheck(part.path)) throw new EditAbort('unsafe', part.path);
    if (part.kind === 'add') {
      if (tree.fetch(part.path) !== null) throw new EditAbort('exists', part.path);
      const content = part.plusLines.map((l) => l.content);
      tree.current.set(part.path, content.length === 0 ? '' : content.join('\n') + '\n');
      return;
    }
    if (part.kind === 'del') {
      if (tree.fetch(part.path) === null) throw new EditAbort('missing', part.path);
      tree.current.set(part.path, null);
      return;
    }
    if (part.destPath !== null && !pathPassesCheck(part.destPath)) throw new EditAbort('unsafe', part.destPath);
    const srcText = tree.fetch(part.path);
    if (srcText === null) throw new EditAbort('missing', part.path);
    if (part.destPath !== null && tree.fetch(part.destPath) !== null) throw new EditAbort('exists', part.destPath);
    const fv = viewOfText(srcText);
    let rows = fv.rows;
    let cursor = 0;
    for (const piece of part.pieces) {
      if (piece.anchorText !== null) {
        const anchorFound = bestTierHits(rows, [piece.anchorText], cursor);
        if (anchorFound === null) throw new EditAbort('no-match', part.path);
        cursor = anchorFound.at[0]! + 1;
      }
      const before: string[] = [];
      const after: string[] = [];
      const ctxIdx: (number | null)[] = [];
      for (const r of piece.rows) {
        if (r.kind === 'ctx') {
          before.push(r.content);
          after.push(r.content);
          ctxIdx.push(before.length - 1);
        } else if (r.kind === 'old') before.push(r.content);
        else {
          after.push(r.content);
          ctxIdx.push(null);
        }
      }
      if (before.length === 0) {
        const pos = piece.atEof ? rows.length : Math.min(cursor, rows.length);
        rows = [...rows.slice(0, pos), ...after, ...rows.slice(pos)];
        cursor = pos + after.length;
        continue;
      }
      const found = bestTierHits(rows, before, cursor);
      if (found === null) throw new EditAbort('no-match', part.path);
      let pos = -1;
      for (const cand of found.at) {
        if (piece.atEof && cand + before.length !== rows.length) continue;
        pos = cand;
        break;
      }
      if (pos < 0) throw new EditAbort('no-match', part.path);
      const replacement = buildReplacement(rows, pos, before, after, ctxIdx, found.tier);
      rows = [...rows.slice(0, pos), ...replacement, ...rows.slice(pos + before.length)];
      cursor = pos + replacement.length;
    }
    const resultText = textOfView({ rows, breakStr: fv.breakStr, endsWithBreak: fv.endsWithBreak });
    if (part.destPath !== null) {
      tree.current.set(part.destPath, resultText);
      tree.current.set(part.path, null);
      tree.moved.set(part.destPath, part.path);
    } else {
      tree.current.set(part.path, resultText);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9): the text-editor tool calls — create, str_replace
// and insert — supplied either as a single JSON array or as one object
// per line.
// ---------------------------------------------------------------------------

// Turns one JSON value into an edit when it is a recognisable edit object;
// returns null when it is not.
function editFromJson(val: unknown): EditStep | null {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return null;
  const obj = val as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;
  const requireText = (tree: TreeState): string => {
    if (!pathPassesCheck(path)) throw new EditAbort('unsafe', path);
    const t = tree.fetch(path);
    if (t === null) throw new EditAbort('missing', path);
    return t;
  };
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const content = obj.file_text;
    return (tree) => {
      if (!pathPassesCheck(path)) throw new EditAbort('unsafe', path);
      if (tree.fetch(path) !== null) throw new EditAbort('exists', path);
      tree.current.set(path, content);
    };
  }
  if (obj.command === 'str_replace' && typeof obj.old_str === 'string' && obj.old_str !== '' && (obj.new_str === undefined || typeof obj.new_str === 'string')) {
    const oldText = obj.old_str;
    const newText = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const srcText = requireText(tree);
      const nlAt = srcText.indexOf('\n');
      const crlf = nlAt > 0 && srcText[nlAt - 1] === '\r';
      const asLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const flat = asLf(srcText);
      const needle = asLf(oldText);
      let hits = 0;
      let probe = flat.indexOf(needle);
      while (probe >= 0) {
        hits += 1;
        probe = flat.indexOf(needle, probe + 1);
      }
      if (hits === 0) throw new EditAbort('no-match', path);
      if (hits > 1) throw new EditAbort('ambiguous', path);
      const pos = flat.indexOf(needle);
      const result = flat.slice(0, pos) + asLf(newText) + flat.slice(pos + needle.length);
      tree.current.set(path, crlf ? result.replaceAll('\n', '\r\n') : result);
    };
  }
  if (obj.command === 'insert' && typeof obj.insert_line === 'number' && Number.isInteger(obj.insert_line) && typeof obj.new_str === 'string') {
    const afterLine = obj.insert_line;
    const extra = chopPatchLines(obj.new_str);
    return (tree) => {
      const srcText = requireText(tree);
      const nlAt = srcText.indexOf('\n');
      const breakStr = nlAt > 0 && srcText[nlAt - 1] === '\r' ? '\r\n' : '\n';
      const rows = srcText === '' ? [] : srcText.split(breakStr);
      const tailBreak = srcText !== '' && srcText.endsWith(breakStr);
      if (tailBreak) rows.pop();
      if (afterLine < 0 || afterLine > rows.length) throw new EditAbort('no-match', path);
      rows.splice(afterLine, 0, ...extra);
      tree.current.set(path, rows.length === 0 ? '' : rows.join(breakStr) + (tailBreak ? breakStr : ''));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditStep[] {
  const headAt = lines.findIndex((l) => !lineIsBlank(l));
  if (headAt < 0) throw new ParseAbort('error: parse 1');
  const steps: EditStep[] = [];
  if (lines[headAt]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseAbort(`error: parse ${headAt + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseAbort(`error: parse ${headAt + 1}`);
    for (const entry of parsed) {
      const step = editFromJson(entry);
      if (step === null) throw new ParseAbort(`error: parse ${headAt + 1}`);
      steps.push(step);
    }
    return steps;
  }
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!;
    if (lineIsBlank(line)) continue;
    let step: EditStep | null = null;
    try {
      step = editFromJson(JSON.parse(line));
    } catch {
      step = null;
    }
    if (step === null) throw new ParseAbort(`error: parse ${n + 1}`);
    steps.push(step);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Format detection (section 4) and the driver. run() parses the arguments,
// reads the patch, turns it into edits and plays them against a TreeState,
// undoing each edit that fails; only a patch whose edits all succeeded is
// written to disk and reported.
// ---------------------------------------------------------------------------

// Which format a patch is in, decided by the section 4 tests in their
// order; null when none of them holds.
function detectFormat(lines: string[]): string | null {
  const headAt = lines.findIndex((l) => !lineIsBlank(l));
  if (headAt < 0) return null;
  const head = lines[headAt]!;
  if (head.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = head.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  if (lines.some((l) => trimRightWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  const hasGitHeader = lines.some((l) => l.startsWith('diff --git '));
  const hasPair = lines.some((l, i) => l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  if (hasGitHeader || hasPair) return 'unified';
  return null;
}

const FORMAT_CHOICES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface ReportLine {
  sortKey: string;
  text: string;
  path: string;
  content: string | null;
}

// The change report for a fully applied patch: one row per path whose
// state changed, ordered by the byte order of the sort keys, with each
// successful move folded into a single R row (keyed by its new path) in
// place of that pair's D and A rows. Also returns the old paths of those
// moves, whose files run() still has to remove from disk afterwards.
function makeReport(work: TreeState): { rows: ReportLine[]; removedSources: Set<string> } {
  const removedSources = new Set<string>();
  const bornPaths = new Set<string>();
  for (const [np, op] of work.moved) {
    if (work.diskText(op) !== null && work.current.get(op) === null && work.diskText(np) === null && work.current.get(np) !== null) {
      removedSources.add(op);
      bornPaths.add(np);
    }
  }
  const rows: ReportLine[] = [];
  for (const np of bornPaths) rows.push({ sortKey: np, text: `R ${work.moved.get(np)!} -> ${np}`, path: np, content: work.current.get(np)! });
  for (const p of work.current.keys()) {
    if (removedSources.has(p) || bornPaths.has(p)) continue;
    const was = work.diskText(p);
    const nowVal = work.current.get(p)!;
    if (was === nowVal) continue;
    rows.push({ sortKey: p, text: `${was === null ? 'A' : nowVal === null ? 'D' : 'M'} ${p}`, path: p, content: nowVal });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey), Buffer.from(y.sortKey)));
  return { rows, removedSources };
}

function run(args: string[]): { code: number; out: string[] } {
  let fmtPick: string | null = null;
  let checkOnly = false;
  let strict = false;
  const rest: string[] = [];
  let pastSep = false;
  for (const arg of args) {
    if (!pastSep && arg === '--') pastSep = true;
    else if (!pastSep && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && fmtPick === null && FORMAT_CHOICES.includes(arg.slice(9))) fmtPick = arg.slice(9);
      else if (arg === '--check' && !checkOnly) checkOnly = true;
      else if (arg === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else rest.push(arg);
  }
  if (rest.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = rest.length === 0 || rest[0] === '-' ? null : rest[0]!;
  let patchBody = '';
  try {
    patchBody = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const patchLines = chopPatchLines(patchBody);
  const kind = fmtPick === null || fmtPick === 'auto' ? detectFormat(patchLines) : fmtPick;
  if (kind === null) return { code: 2, out: ['error: format'] };
  loosestTier = strict ? 0 : 2;
  let steps: EditStep[];
  try {
    if (kind === 'json') steps = parseJsonEdits(patchBody, patchLines);
    else if (kind === 'unified') steps = parseUnified(patchLines);
    else if (kind === 'search-replace') steps = parseSearchReplace(patchLines);
    else steps = parseV4a(patchLines);
    if (steps.length === 0) throw new ParseAbort('error: parse 1');
  } catch (e) {
    if (e instanceof ParseAbort) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new TreeState();
  const failures: EditAbort[] = [];
  for (const step of steps) {
    const savedCurrent = new Map(tree.current);
    const savedMoved = new Map(tree.moved);
    try {
      step(tree);
    } catch (e) {
      if (!(e instanceof EditAbort)) throw e;
      tree.current.clear();
      for (const [k, v] of savedCurrent) tree.current.set(k, v);
      tree.moved.clear();
      for (const [k, v] of savedMoved) tree.moved.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${steps.length} edits`] };
  const { rows, removedSources } = makeReport(tree);
  const report: string[] = [];
  for (const r of rows) {
    report.push(r.text);
    if (checkOnly) continue;
    if (r.content === null) rmSync(r.path, { force: true });
    else {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.content);
    }
  }
  if (!checkOnly) for (const op of removedSources) rmSync(op, { force: true });
  return { code: 0, out: [...report, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
