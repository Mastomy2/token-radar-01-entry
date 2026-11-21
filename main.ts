// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// clean pre-token protocol with the radar-4 fitted model in lib/model.ts (terms fitted in lib/fit.ts
// and tested held-out twice, in two independent designs), writes the ranked board to
// /output/board.json, and copies this repository's dashboard/ and screenshots/ to /output. Last, it
// writes /output/dossier.json, the summary the judge reads, with the vendored make.fun library.
//
// radar-4 differs from the house starter in four ways the dashboard states: the board carries only
// clean pre-token protocols (a wrapped, staked or bridged product of a token that already trades never
// ranks), each category is scored at its own market multiple — the median market-cap / TVL of that
// category's live-token protocols, shrunk toward the global median and winsorized at the 95th
// percentile, computed from the snapshot at run time — every row carries launch odds from its peers'
// record and a costed farm verdict, and every farm plan is seven steps with chain-aware gas. The
// dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read /output/data.js, which this
// program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildRadarFitted } from './lib/model.ts';
import type { BoardRow } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Strict board audit, run before anything is written: every row must carry a
 *  positive implied value and, where it has one, a symbol no other row uses.
 *  The gate's own boardIssue checks coverage, ranks, order and farm steps; this
 *  audit adds the data-integrity half — a board that passes both cannot ship a
 *  row with a nonsense value or two rows claiming the same ticker. Returns the
 *  first problem found, or null when the board is clean. */
function strictBoardIssue(board: BoardRow[]): string | null {
  const seenSymbols = new Map<string, number>();
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    const where = `row ${row.rank} (${row.slug})`;
    if (row.rank !== i + 1) return `${where}: rank is ${row.rank}, expected ${i + 1}`;
    if (row.slug.trim().length === 0) return `row ${i + 1}: slug is empty`;
    if (row.name.trim().length === 0) return `${where}: name is empty`;
    if (!Number.isFinite(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${where}: implied value is ${row.implied_value_usd}, must be a finite number above 0`;
    }
    if (!Number.isFinite(row.tvl_usd) || row.tvl_usd < 0) {
      return `${where}: TVL is ${row.tvl_usd}, must be a finite number at or above 0`;
    }
    if (row.category !== null && row.category.trim().length === 0) return `${where}: category is blank`;
    if (row.chains.length === 0) return `${where}: no chains listed`;
    if (row.change_7d !== null && !Number.isFinite(row.change_7d)) {
      return `${where}: 7d change is not a finite number`;
    }
    if (row.age_days !== null && (!Number.isFinite(row.age_days) || row.age_days < 0)) {
      return `${where}: age is ${row.age_days}, must be a finite number at or above 0`;
    }
    if (row.symbol !== null) {
      const symbol = row.symbol.trim();
      if (symbol.length === 0) return `${where}: symbol is blank`;
      const key = symbol.toUpperCase();
      const first = seenSymbols.get(key);
      if (first !== undefined) return `${where}: symbol ${symbol} is already used by row ${first}`;
      seenSymbols.set(key, row.rank);
    }
    if (row.farm_steps.length !== 7) {
      return `${where}: farm plan has ${row.farm_steps.length} steps, the radar promises 7`;
    }
    for (const step of row.farm_steps) {
      if (step.trim().length === 0) return `${where}: farm plan has a blank step`;
    }
  }
  return null;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadarFitted(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const strictIssue = strictBoardIssue(board);
if (strictIssue !== null) {
  process.stderr.write(`token radar: the board failed the strict audit: ${strictIssue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
  const shot = readFileSync(join(out, 'screenshots', name));
  const shotW = shot.readUInt32BE(16);
  const shotH = shot.readUInt32BE(20);
  if (Math.min(shotW, shotH) < 800) {
    process.stderr.write(`token radar: screenshots/${name} is ${shotW}x${shotH}: short side under 800px, the dev gate needs at least 800\n`);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: radar-4 fit on ${radar.fit?.liveFittable ?? 0} live protocols: held-out median log error ${radar.fit?.folds.map((f) => f.heldOutMedianAbsLogError).join(' / ') ?? 'n/a'} vs radar-2 baseline ${radar.fit?.folds.map((f) => f.baselineMedianAbsLogError).join(' / ') ?? 'n/a'}\n` +
    `token radar: strict audit passed: ${board.length} rows, positive implied values, no duplicate symbols\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
