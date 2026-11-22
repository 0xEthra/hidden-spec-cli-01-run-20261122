// main.ts is mend, the CLI SPEC.md specifies. It applies the edits AI models write, in four formats, to a tree
// of text files: unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and
// JSON edits (section 9), matching lines at three tiers (section 5), with the command line, output and exit
// codes, safe paths and format detection of sections 1 to 4 and the all-or-nothing write of section 10.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function decode(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { lines: body === '' ? [''] : body.split(br), br, ends };
}

function encode(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as tier t sees it: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every 0-based start where O occurs in lines at tier t; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N at tier 2: P (leading ws of O's first line) replaced by F (file's). */
function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\' noeol. */
interface BodyLine {
  k: string;
  t: string;
}

/**
 * The replacement lines for a hunk/chunk body: a context line is the file's own matched line, a `+` line is
 * written as it is (re-indented at tier 2), `-` and `\` lines write nothing. `pos` is the occurrence start,
 * `o` the old lines (for the tier-2 re-indent base); pass tier null when O is empty (no match, no re-indent).
 */
function buildReplacement(body: BodyLine[], fileLines: string[], pos: number, tier: number | null, o: string[]): string[] {
  const out: string[] = [];
  let oi = 0;
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  for (const b of body) {
    if (b.k === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.k === '-') {
      oi += 1;
    } else if (b.k === '+') {
      out.push(tier === 2 ? reindentLine(b.t, p, f) : b.t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, for the `R` output lines (section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** One leading `a/` or `b/` is removed from a `---`/`+++` path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first tab, spaces trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

/**
 * Apply one hunk to the file model, returning N's length minus O's length (the section's running d).
 * O is the hunk's context and `-` lines, N its context and `+` lines, each in body order.
 */
function applyHunk(m: FileModel, h: UHunk, d: number, strict: boolean, path: string): number {
  const items = h.body;
  // A `\` line suppresses the final break only when it directly follows the hunk's last context or `+` line.
  let suppress = false;
  if (items.length >= 2) {
    const last = items[items.length - 1]!;
    const prev = items[items.length - 2]!;
    if (last.k === '\\' && (prev.k === ' ' || prev.k === '+')) suppress = true;
  }
  const o = items.filter((it) => it.k === ' ' || it.k === '-').map((it) => it.t);
  if (o.length === 0) {
    const nLines = buildReplacement(items, m.lines, 0, null, []);
    const pos = Math.max(0, Math.min(h.a + d, m.lines.length));
    const atEnd = pos === m.lines.length;
    m.lines.splice(pos, 0, ...nLines);
    if (atEnd) m.ends = !suppress;
    return nLines.length;
  }
  const found = findTier(m.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  // Of the occurrences at the tier where O is found, take the one nearest to A - 1 + d; ties go to the earlier.
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dd = Math.abs(p - target);
    if (dd < bestDist) {
      best = p;
      bestDist = dd;
    }
  }
  const nLines = buildReplacement(items, m.lines, best, found.tier, o);
  const toEnd = best + o.length === m.lines.length;
  m.lines.splice(best, o.length, ...nLines);
  if (toEnd) m.ends = !suppress;
  return nLines.length - o.length;
}

function unifiedSectionEdit(oldP: string | null, newP: string | null, sec: USection, strict: boolean): Edit {
  return (tree) => {
    // Safety of every path the edit names comes before anything else about it.
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    const isCreate = (sec.newFile || oldP === null) && newP !== null;
    const isDelete = !isCreate && (sec.deletedFile || newP === null);
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.k === '+') plus.push(b.t);
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      let ends = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.k === '+') {
            ends = !(bi + 1 < body.length && body[bi + 1]!.k === '\\');
            break outer;
          }
        }
      }
      tree.now.set(np, encode({ lines: plus, br: '\n', ends: plus.length > 0 && ends }));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const op = oldP!;
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const m = decode(text);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(m, h, d, strict, op);
    const out = encode(m);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(op, null);
      tree.moves.push([op, newP!]);
    } else {
      tree.now.set(op, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curHunk: UHunk | null = null;
  let inBody = false;
  const newSection = (): USection => ({
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const endBody = (): void => {
    if (curHunk !== null && cur !== null) {
      // Empty lines at the end of a body are not part of it.
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.k === ' ' && last.t === '') curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
    }
    curHunk = null;
    inBody = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      // The body ends at a `--- ` line followed by a `+++ ` line, at a `diff --git ` line, or at any other line.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (line.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk!.body.push({ k: line === '' ? ' ' : line[0]!, t: line === '' ? '' : line.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line outside a body is a header line: it must be followed by a `+++ ` line, else the parse
      // error is named at the line after it.
      const nxt = lines[i + 1];
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(nxt);
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(nxt);
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(hm[1]), body: [] };
      inBody = true;
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Header lines before the first hunk; anything else here is ignored.
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  if (inBody) endBody();
  return sections.map((sec) => {
    const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.gitOld);
    const newP = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.gitNew);
    return unifiedSectionEdit(oldP, newP, sec, strict);
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // An empty old side creates the file from the new lines (empty new side: an empty file).
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, encode({ lines: [...newLines], br: '\n', ends: newLines.length > 0 }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const m = decode(text);
    const found = findTier(m.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nLines =
      found.tier === 2
        ? newLines.map((l) => reindentLine(l, leadWs(oldLines[0]!), leadWs(m.lines[pos]!)))
        : [...newLines];
    m.lines.splice(pos, oldLines.length, ...nLines);
    tree.now.set(path, encode(m));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before SEARCH (and after the previous block) that is not blank and,
    // trimmed, does not start with three backticks; failing that, the previous block's path.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

/** Surrounding spaces (only spaces) removed, as V4A paths and anchors specify. */
function spaceTrim(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

interface VChunk {
  /** Null: no anchor (an empty anchor text is also no anchor). */
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** The first line at or after `cursor` equal to the single-line anchor, at the first tier with one. */
function findAnchorLine(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (norm(lines[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return -1;
}

/**
 * The first occurrence of O at or after `cursor`, at the first tier with one; an end-of-file chunk only
 * takes an occurrence that ends at the file's last line.
 */
function findChunkOcc(lines: string[], o: string[], cursor: number, eof: boolean, strict: boolean): { pos: number; tier: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t).filter((p) => p >= cursor && (!eof || p + o.length === lines.length));
    if (occ.length > 0) return { pos: occ[0]!, tier: t };
  }
  return null;
}

function v4aSectionEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = decode(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchorLine(m.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = ch.body.filter((b) => b.k === ' ' || b.k === '-').map((b) => b.t);
      if (o.length === 0) {
        const nLines = buildReplacement(ch.body, m.lines, cursor, null, []);
        const pos = ch.eof ? m.lines.length : cursor;
        m.lines.splice(pos, 0, ...nLines);
        cursor = pos + nLines.length;
        continue;
      }
      const found = findChunkOcc(m.lines, o, cursor, ch.eof, strict);
      if (found === null) throw new Fail('no-match', path);
      const nLines = buildReplacement(ch.body, m.lines, found.pos, found.tier, o);
      m.lines.splice(found.pos, o.length, ...nLines);
      // The cursor moves to just after the lines written (the start, when N is empty).
      cursor = found.pos + nLines.length;
    }
    // Section 8 sets no noeol rule: a changed file keeps the final break it had.
    const out = encode(m);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = spaceTrim(line.slice('*** Add File: '.length));
      i += 1;
      const bodyLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          bodyLines.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          bodyLines.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, encode({ lines: bodyLines, br: '\n', ends: bodyLines.length > 0 }));
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = spaceTrim(line.slice('*** Delete File: '.length));
      i += 1;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = spaceTrim(line.slice('*** Update File: '.length));
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = spaceTrim(lines[i]!.slice('*** Move to: '.length));
        i += 1;
      }
      // The section's raw lines run to the next section or the final `*** End Patch`; blank lines at the
      // end of the section are not part of it.
      const raw: Array<{ text: string; idx: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        raw.push({ text: l, idx: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let afterEof = false;
      const endChunk = (): void => {
        if (curChunk !== null) chunks.push(curChunk);
        curChunk = null;
      };
      for (const { text: l, idx } of raw) {
        if (l.startsWith('@@')) {
          endChunk();
          curChunk = { anchor: spaceTrim(l.slice(2)), eof: false, body: [] };
          afterEof = false;
          continue;
        }
        if (l === '*** End of File') {
          // It ends a chunk and anchors it to the end of the file; with no chunk open it ends nothing.
          if (curChunk !== null) {
            curChunk.eof = true;
            endChunk();
            afterEof = true;
          }
          continue;
        }
        const isBody = l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
        if (!isBody) throw new Exit2(`error: parse ${idx + 1}`);
        // A body line after `*** End of File` cannot start a chunk: only the first chunk may start at a
        // body line, and it already exists by then.
        if (afterEof) throw new Exit2(`error: parse ${idx + 1}`);
        if (curChunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          curChunk = { anchor: null, eof: false, body: [] };
        }
        curChunk.body.push({ k: l === '' ? ' ' : l[0]!, t: l === '' ? '' : l.slice(1) });
      }
      endChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aSectionEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const mv of beforeMoves) tree.moves.push(mv);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move is one `R old -> new` line (sorting by <new>) instead of its `D`/`A` pair,
  // when <old> existed before and not after, and <new> did not exist before and does after.
  const entries: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      entries.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
