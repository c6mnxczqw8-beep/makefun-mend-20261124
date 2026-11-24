// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
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

// ---- Sections 3 and 5: file lines and tiered matching ----
interface FileLines { lines: string[]; br: string; final: boolean }
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}
function joinCreated(lines: string[], final: boolean): string {
  return lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : '');
}
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}
function tiersOf(strict: boolean): number[] { return strict ? [0] : [0, 1, 2]; }
/** All start positions where O matches file lines at a tier. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) if (!lineEq(lines[i + k]!, O[k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function findMatch(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const tier of tiersOf(strict)) {
    const positions = occurrences(lines, O, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}
type BodyEntry = { type: 'context' | 'old' | 'new' | 'bs'; text: string; srcEmpty?: boolean };
/** Build replacement lines for a body (context/old/new entries) matched at pos. */
function buildReplacement(fileLines: string[], pos: number, O: string[], body: BodyEntry[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const F = fileLines[pos] !== undefined ? leadOf(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadOf(O[0]!) : '';
  const reindent = (s: string): string => {
    if (tier !== 2) return s;
    if (s === '' || s.trim() === '') return s;
    if (P === '') return F + s;
    return s.startsWith(P) ? F + s.slice(P.length) : s;
  };
  for (const e of body) {
    if (e.type === 'context') { out.push(fileLines[pos + oi]!); oi += 1; }
    else if (e.type === 'old') oi += 1;
    else if (e.type === 'new') out.push(reindent(e.text));
  }
  return out;
}
/** Whether a backslash entry immediately follows the body's last context/new entry. */
function bsAfterLastWrite(body: BodyEntry[]): boolean {
  let last = -1;
  body.forEach((e, i) => { if (e.type === 'context' || e.type === 'new') last = i; });
  return last >= 0 && body[last + 1]?.type === 'bs';
}
// ---- Section 6: unified diffs ----
interface Hunk { a: number; body: BodyEntry[] }
interface Section {
  oldP: string | null | undefined; newP: string | null | undefined;
  diffOld: string | undefined; diffNew: string | undefined;
  renFrom: string | undefined; renTo: string | undefined;
  newFile: boolean; delFile: boolean; hunks: Hunk[]; hasPair: boolean;
}
function parsePathField(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = { oldP: undefined, newP: undefined, diffOld: undefined, diffNew: undefined, renFrom: undefined, renTo: undefined, newFile: false, delFile: false, hunks: [], hasPair: false };
    sections.push(s); return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+) b\/(.+)$/.exec(line.slice(11));
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(); cur.diffOld = m[1]!; cur.diffNew = m[2]!;
      i += 1; continue;
    }
    const isPairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (isPairStart && (cur === null || cur.hunks.length > 0 || cur.hasPair)) {
      cur = newSection();
      cur.oldP = parsePathField(line.slice(4)); cur.newP = parsePathField(lines[i + 1]!.slice(4)); cur.hasPair = true;
      i += 2; continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') { hunk.body.push({ type: 'context', text: '', srcEmpty: true }); i += 1; continue; }
        const c = bl[0]!;
        if (c === ' ') hunk.body.push({ type: 'context', text: bl.slice(1) });
        else if (c === '-') hunk.body.push({ type: 'old', text: bl.slice(1) });
        else if (c === '+') hunk.body.push({ type: 'new', text: bl.slice(1) });
        else if (c === '\\') hunk.body.push({ type: 'bs', text: '' });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.srcEmpty) hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // section header
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldP = parsePathField(line.slice(4)); cur.newP = parsePathField(lines[i + 1]!.slice(4)); cur.hasPair = true;
        i += 2; continue;
      }
      if (line.startsWith('rename from ')) cur.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1; continue;
    }
    i += 1; // prose / ignored lines outside bodies and headers
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}
function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null | undefined = s.hasPair ? s.oldP : s.renFrom !== undefined ? s.renFrom : s.diffOld;
    let newP: string | null | undefined = s.hasPair ? s.newP : s.renTo !== undefined ? s.renTo : s.diffNew;
    const isCreate = oldP === null || s.newFile;
    const isDelete = newP === null || s.delFile;
    if (isCreate) oldP = null;
    if (isDelete) newP = null;
    // Safety before anything else, in old-then-new order.
    if (typeof oldP === 'string') checkSafe(oldP);
    if (typeof newP === 'string') checkSafe(newP);
    if (oldP === undefined && newP === undefined) throw new Fail('missing', '');
    if (isCreate) {
      const target = (newP ?? oldP) as string;
      checkSafe(target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const outLines: string[] = [];
      let final = true;
      for (const h of s.hunks) {
        h.body.forEach((e, idx) => {
          if (e.type === 'new') { outLines.push(e.text); final = true; }
          else if (e.type === 'bs' && idx > 0 && h.body[idx - 1]!.type === 'new') final = false;
        });
      }
      // A trailing backslash after the very last + line decides the final break.
      const all = s.hunks.flatMap((h) => h.body);
      let lastNew = -1; all.forEach((e, idx) => { if (e.type === 'new') lastNew = idx; });
      final = !(lastNew >= 0 && all[lastNew + 1]?.type === 'bs');
      tree.now.set(target, joinCreated(outLines, final));
      return;
    }
    if (isDelete) {
      const target = oldP as string;
      mustExist(tree, target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP as string; const dst = newP as string;
    const before = mustExist(tree, src);
    const isMove = src !== dst;
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const O = h.body.filter((e) => e.type === 'context' || e.type === 'old').map((e) => e.text);
      const N = h.body.filter((e) => e.type === 'context' || e.type === 'new').map((e) => e.text);
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...N);
        if (atEnd && N.length > 0) f.final = !bsAfterLastWrite(h.body);
        d += N.length;
        continue;
      }
      const found = findMatch(f.lines, O, strict);
      if (!found) throw new Fail('no-match', src);
      const targetPos = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - targetPos) < Math.abs(best - targetPos)) best = p;
      const atEnd = best + O.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, O, h.body, found.tier);
      f.lines.splice(best, O.length, ...repl);
      if (atEnd) f.final = !bsAfterLastWrite(h.body);
      d += N.length - O.length;
    }
    const text = joinFile(f);
    if (isMove) { tree.now.set(src, null); tree.now.set(dst, text); tree.moves.push({ old: src, next: dst }); }
    else tree.now.set(src, text);
  };
}

// ---- Section 7: SEARCH/REPLACE ----
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim(); break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1; let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    if (eq >= 0) for (let j = eq + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path; const O = oldLines; const N = newLines;
    edits.push((tree) => {
      checkSafe(p);
      if (O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinCreated(N, true));
        return;
      }
      const before = mustExist(tree, p);
      const f = splitFile(before);
      const found = findMatch(f.lines, O, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      // No context lines here: every new line is re-indented at tier 2.
      const body: BodyEntry[] = [
        ...O.map((t): BodyEntry => ({ type: 'old', text: t })),
        ...N.map((t): BodyEntry => ({ type: 'new', text: t })),
      ];
      const repl = buildReplacement(f.lines, pos, O, body, found.tier);
      f.lines.splice(pos, O.length, ...repl);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path; searchFrom = end + 1; i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A ----
interface VChunk { anchor: string | null; eof: boolean; body: BodyEntry[] }
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isHeader = (l: string): string | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const kind = isHeader(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = lines[i]!.slice(lines[i]!.indexOf(': ') + 2).trim();
    i += 1;
    const start = i;
    while (i < last && isHeader(lines[i]!) === null) i += 1;
    let seg = lines.slice(start, i);
    const segLine = (idx: number): number => start + idx + 1;
    while (seg.length > 0 && blank(seg[seg.length - 1]!)) seg.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      seg.forEach((l, idx) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${segLine(idx)}`);
      });
      const p = path;
      edits.push((tree) => {
        checkSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinCreated(fileLines, true));
      });
    } else if (kind === 'del') {
      if (seg.length > 0) throw new Exit2(`error: parse ${segLine(0)}`);
      const p = path;
      edits.push((tree) => { checkSafe(p); mustExist(tree, p); tree.now.set(p, null); });
    } else {
      // update
      let moveTo: string | null = null;
      let idx = 0;
      if (seg.length > 0 && seg[0]!.startsWith('*** Move to: ')) { moveTo = seg[0]!.slice(13).trim(); idx = 1; }
      const chunks: VChunk[] = [];
      let curC: VChunk | null = null;
      for (; idx < seg.length; idx += 1) {
        const l = seg[idx]!;
        if (l.startsWith('@@')) {
          curC = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(curC); continue;
        }
        if (l.trim() === '*** End of File') {
          if (curC === null) { curC = { anchor: null, eof: false, body: [] }; chunks.push(curC); }
          curC.eof = true; curC = null; continue;
        }
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${segLine(idx)}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curC === null) { curC = { anchor: null, eof: false, body: [] }; chunks.push(curC); }
          if (l === '') curC.body.push({ type: 'context', text: '' });
          else if (l[0] === ' ') curC.body.push({ type: 'context', text: l.slice(1) });
          else if (l[0] === '-') curC.body.push({ type: 'old', text: l.slice(1) });
          else curC.body.push({ type: 'new', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${segLine(idx)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path; const mv = moveTo; const chs = chunks;
      edits.push((tree) => {
        checkSafe(p);
        if (mv !== null) checkSafe(mv);
        const before = mustExist(tree, p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            let anchorPos = -1;
            for (const tier of tiersOf(strict)) {
              for (let k = cursor; k < f.lines.length; k += 1) if (lineEq(f.lines[k]!, ch.anchor, tier)) { anchorPos = k; break; }
              if (anchorPos >= 0) break;
            }
            if (anchorPos < 0) throw new Fail('no-match', p);
            cursor = anchorPos + 1;
          }
          const O = ch.body.filter((e) => e.type === 'context' || e.type === 'old').map((e) => e.text);
          const N = ch.body.filter((e) => e.type === 'context' || e.type === 'new').map((e) => e.text);
          if (O.length === 0) {
            const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
            f.lines.splice(pos, 0, ...N);
            cursor = pos + N.length;
            continue;
          }
          const found = findMatch(f.lines, O, strict, cursor);
          let cand = found;
          if (found && ch.eof) {
            const posEof = found.positions.filter((pp) => pp + O.length === f.lines.length);
            cand = posEof.length > 0 ? { tier: found.tier, positions: posEof } : null;
            if (cand === null) {
              // Try other tiers specifically for an end-anchored occurrence.
              for (const tier of tiersOf(strict)) {
                const ps = occurrences(f.lines, O, tier, cursor).filter((pp) => pp + O.length === f.lines.length);
                if (ps.length > 0) { cand = { tier, positions: ps }; break; }
              }
            }
          }
          if (!cand) throw new Fail('no-match', p);
          const pos = cand.positions[0]!;
          const repl = buildReplacement(f.lines, pos, O, ch.body, cand.tier);
          f.lines.splice(pos, O.length, ...repl);
          cursor = pos + repl.length;
        }
        const text = joinFile(f);
        if (mv !== null) { tree.now.set(p, null); tree.now.set(mv, text); tree.moves.push({ old: p, next: mv }); }
        else tree.now.set(p, text);
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function mustExist(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}
function checkSafe(p: string): void { if (!safe(p)) throw new Fail('unsafe', p); }

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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Move pairs that satisfy section 2 collapse their D+A lines into one R line, sorted by the new path.
  const movePairs = tree.moves.filter((m) =>
    tree.original(m.old) !== null && tree.original(m.next) === null &&
    tree.now.get(m.old) === null && tree.now.get(m.next) !== null && tree.now.get(m.next) !== undefined);
  const suppressed = new Set<string>();
  for (const m of movePairs) { suppressed.add(m.old); suppressed.add(m.next); }
  type Row = { key: string; text: string };
  const rowObjs: Row[] = [];
  for (const m of movePairs) rowObjs.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!suppressed.has(p)) rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowObjs.map((r) => r.text);
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
