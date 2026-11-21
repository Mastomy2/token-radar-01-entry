// radar-4 fit: every value term of the radar's model is fitted from the snapshot's own
// live-token protocols, and tested held-out twice, in two independent designs — never hand-set.
//
// The live-token protocols are the model's only ground truth: their market cap is a fact,
// so the model that prices pre-token protocols can be scored against it. The fit predicts
// log market cap for a live protocol from its own TVL, category multiple, 7-day growth and
// age, exactly the arithmetic the board uses, and searches the value terms (growth weight,
// maturity floor and range, multiple clamp) for the smallest median absolute log error.
//
// Held out, twice, honestly: the candidate is never picked on the set it is scored on.
// Each hash-split fold picks its winner on an inner split of its own fit half, then scores
// that winner once on the held-out half it has never met. The time split is a second,
// independent design: older protocols fit, newer ones are held out, so the report also says
// whether the terms would have predicted the protocols that came later. The final model is
// fitted on all live protocols. The hand-set radar-2 constants are scored on the same
// folds, so the report says how much the fit actually buys.

import type { ModelConstants, Snapshot, SnapshotProtocol } from './model.ts';

/** The fitted model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION_FITTED = 'radar-4';

/** One fold's fit: what was fitted, on how much, and how it did out of sample. */
export interface FoldResult {
  fold: string;
  fitSize: number;
  testSize: number;
  growthWeight: number;
  maturityFloor: number;
  maturityRange: number;
  multipleFloor: number;
  multipleCap: number;
  heldOutMedianAbsLogError: number;
  baselineMedianAbsLogError: number;
  /** Where the fold's candidate was picked: never on the held-out half. */
  selection: string;
}

/** The whole fit: both folds, the final model, and its full-sample error. */
export interface FitReport {
  modelVersion: string;
  liveFittable: number;
  folds: FoldResult[];
  finalModel: ModelConstants;
  fullSampleMedianAbsLogError: number;
  baselineFullSampleMedianAbsLogError: number;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A deterministic fold for a slug: a small string hash, even or odd. */
function foldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 2;
}

/** A second, independent fold for a slug: a position-weighted sum, so its parity depends on
 *  the characters at even positions only — a genuinely different partition from foldOf.
 *  (A seed change or a different multiplier would not do: with odd multipliers any such
 *  hash's low bit is just the seed's bit xor the xor of the character-code parities, so
 *  the two partitions would be the same split, flipped.) */
function innerFoldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h + slug.charCodeAt(i) * (i + 1)) >>> 0;
  return h % 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageDaysOf(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** The shrinkage prior for a category multiple: a category's own median counts as this many
 *  global observations. It mirrors model.multiple_min_samples, so the fit scores the same
 *  pricing rule the board uses: one live comparable moves the multiple part-way from the
 *  global median, never all the way, and a category with no live comparable stays global. */
const SHRINKAGE_PRIOR = 3;

/** The category multiples of one set of live protocols: median market-cap / TVL per category,
 *  shrunk toward the global median with the prior above, then clamped by the candidate.
 *  Each live ratio is winsorized at the set's own 95th percentile first, so one token priced
 *  at 400x its TVL cannot set a whole category's multiple on its own. */
function multiplesOf(
  live: SnapshotProtocol[],
): { byCategory: Map<string, number>; global: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of live) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category) ?? [];
      list.push(ratio);
      byCategory.set(p.category, list);
    }
  }
  const sorted = [...all].sort((a, b) => a - b);
  const winsor =
    sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]! : 1;
  const win = (r: number): number => Math.min(r, winsor);
  const global = all.length > 0 ? median(all.map(win)) : 0.25;
  const multiples = new Map<string, number>();
  for (const [category, values] of byCategory.entries()) {
    multiples.set(
      category,
      (values.length * median(values.map(win)) + SHRINKAGE_PRIOR * global) /
        (values.length + SHRINKAGE_PRIOR),
    );
  }
  return { byCategory: multiples, global };
}

/** One protocol's multiple from a fitted multiple set, with the fitted clamp applied. */
function multipleForFit(
  p: SnapshotProtocol,
  multiples: { byCategory: Map<string, number>; global: number },
  floor: number,
  cap: number,
): number {
  const raw =
    p.category !== null && multiples.byCategory.has(p.category)
      ? multiples.byCategory.get(p.category)!
      : multiples.global;
  return Math.min(cap, Math.max(floor, raw));
}

/** The predicted log market cap of one live protocol under one candidate model. */
function predictedLogMcap(
  p: SnapshotProtocol,
  asOf: string,
  multiple: number,
  growthWeight: number,
  maturityFloor: number,
  maturityRange: number,
): number {
  const growth = Math.min(120, Math.max(-60, p.change_7d ?? 0));
  const growthMult = 1 + (growth / 100) * growthWeight;
  const age = ageDaysOf(asOf, p.listed_at) ?? 365;
  const maturityMult =
    maturityFloor + (Math.min(Math.max(age, 0), 1095) / 1095) * maturityRange;
  return Math.log(Math.max(1, p.tvl_usd * multiple * growthMult * maturityMult));
}

/** The median absolute log error of one candidate model on one set of live protocols. */
function medianAbsLogError(
  test: SnapshotProtocol[],
  asOf: string,
  multiples: { byCategory: Map<string, number>; global: number },
  growthWeight: number,
  maturityFloor: number,
  maturityRange: number,
  multipleFloor: number,
  multipleCap: number,
): number {
  const errors: number[] = [];
  for (const p of test) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const multiple = multipleForFit(p, multiples, multipleFloor, multipleCap);
    const predicted = predictedLogMcap(p, asOf, multiple, growthWeight, maturityFloor, maturityRange);
    errors.push(Math.abs(predicted - Math.log(p.mcap_usd)));
  }
  return errors.length > 0 ? median(errors) : Number.POSITIVE_INFINITY;
}

/** The candidate value terms the grid searches. */
interface Candidate {
  growthWeight: number;
  maturityFloor: number;
  maturityRange: number;
  multipleFloor: number;
  multipleCap: number;
}

/** The grid: growth and maturity in steps, the clamp from the live distribution's own spread. */
const GRID: Candidate[] = (() => {
  const out: Candidate[] = [];
  for (const growthWeight of [0, 0.25, 0.5, 0.75, 1.0]) {
    for (const maturityFloor of [0.5, 0.6, 0.7]) {
      for (const maturityRange of [0.3, 0.4, 0.5]) {
        for (const multipleCap of [1.0, 2.0, 5.0]) {
          for (const multipleFloor of [0.02, 0.05]) {
            out.push({ growthWeight, maturityFloor, maturityRange, multipleFloor, multipleCap });
          }
        }
      }
    }
  }
  return out;
})();

/** The radar-2 hand-set constants, scored on the same folds so the fit's gain is measurable. */
const BASELINE: Candidate = {
  growthWeight: 0.5,
  maturityFloor: 0.6,
  maturityRange: 0.4,
  multipleFloor: 0.05,
  multipleCap: 1.0,
};

/** The error of one candidate and of the hand-set baseline on one set, under one multiple set. */
function errorsOn(
  candidate: Candidate,
  testSet: SnapshotProtocol[],
  asOf: string,
  multiples: { byCategory: Map<string, number>; global: number },
): { error: number; baselineError: number } {
  return {
    error: medianAbsLogError(
      testSet,
      asOf,
      multiples,
      candidate.growthWeight,
      candidate.maturityFloor,
      candidate.maturityRange,
      candidate.multipleFloor,
      candidate.multipleCap,
    ),
    baselineError: medianAbsLogError(
      testSet,
      asOf,
      multiples,
      BASELINE.growthWeight,
      BASELINE.maturityFloor,
      BASELINE.maturityRange,
      BASELINE.multipleFloor,
      BASELINE.multipleCap,
    ),
  };
}

/** The best candidate on one fit set, picked on that set's own inner split — never on the
 *  held-out set the fold will be scored against. The inner split is a different partition
 *  (innerFoldOf) from the outer one, so picking the winner cannot peek at the test half:
 *  the reported held-out error is the first time the winner meets those protocols. */
function selectOn(
  fitSet: SnapshotProtocol[],
  asOf: string,
): { candidate: Candidate; selection: string } {
  const innerFit = fitSet.filter((p) => innerFoldOf(p.slug) === 0);
  const innerTest = fitSet.filter((p) => innerFoldOf(p.slug) === 1);
  const usable = innerFit.length > 0 && innerTest.length > 0;
  const multiples = multiplesOf(usable ? innerFit : fitSet);
  const pickFrom = usable ? innerTest : fitSet;
  let best: Candidate = GRID[0]!;
  let bestError = Number.POSITIVE_INFINITY;
  for (const c of GRID) {
    const e = medianAbsLogError(
      pickFrom,
      asOf,
      multiples,
      c.growthWeight,
      c.maturityFloor,
      c.maturityRange,
      c.multipleFloor,
      c.multipleCap,
    );
    if (e < bestError) {
      bestError = e;
      best = c;
    }
  }
  return {
    candidate: best,
    selection: usable
      ? 'candidate picked on the fit half\u2019s inner split, never on the held-out half'
      : 'candidate picked in-sample: the fit half was too small to split',
  };
}

/** One honest held-out fold: pick the candidate on the fit set alone, then score it once,
 *  with the fit set's own multiples, on the held-out set it has never met. */
function honestFold(
  fitSet: SnapshotProtocol[],
  testSet: SnapshotProtocol[],
  asOf: string,
): { candidate: Candidate; error: number; baselineError: number; selection: string } {
  const picked = selectOn(fitSet, asOf);
  const multiples = multiplesOf(fitSet);
  const scored = errorsOn(picked.candidate, testSet, asOf, multiples);
  return { candidate: picked.candidate, error: scored.error, baselineError: scored.baselineError, selection: picked.selection };
}

/** The best candidate on one set, judged in-sample on that same set. Used only for the
 *  final model, which is fitted on every live protocol at once and claims no held-out error. */
function bestInSample(
  set: SnapshotProtocol[],
  asOf: string,
): { candidate: Candidate; error: number; baselineError: number } {
  const multiples = multiplesOf(set);
  let best: Candidate = GRID[0]!;
  let bestError = Number.POSITIVE_INFINITY;
  for (const c of GRID) {
    const e = medianAbsLogError(
      set,
      asOf,
      multiples,
      c.growthWeight,
      c.maturityFloor,
      c.maturityRange,
      c.multipleFloor,
      c.multipleCap,
    );
    if (e < bestError) {
      bestError = e;
      best = c;
    }
  }
  const scored = errorsOn(best, set, asOf, multiples);
  return { candidate: best, error: scored.error, baselineError: scored.baselineError };
}

/** The fitted model and its report: two held-out folds from one hash split (each half fits,
 *  the other is held out), a third from an independent time split (older protocols fit, newer
 *  ones are held out), then a final fit on all live protocols. */
export function fitModel(snapshot: Snapshot): { model: ModelConstants; report: FitReport } {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const foldA = live.filter((p) => foldOf(p.slug) === 0);
  const foldB = live.filter((p) => foldOf(p.slug) === 1);
  const folds: FoldResult[] = [];
  const push = (
    label: string,
    fitSet: SnapshotProtocol[],
    testSet: SnapshotProtocol[],
  ): void => {
    const r = honestFold(fitSet, testSet, snapshot.as_of);
    folds.push({
      fold: label,
      fitSize: fitSet.length,
      testSize: testSet.length,
      growthWeight: r.candidate.growthWeight,
      maturityFloor: r.candidate.maturityFloor,
      maturityRange: r.candidate.maturityRange,
      multipleFloor: r.candidate.multipleFloor,
      multipleCap: r.candidate.multipleCap,
      heldOutMedianAbsLogError: Math.round(r.error * 1e4) / 1e4,
      baselineMedianAbsLogError: Math.round(r.baselineError * 1e4) / 1e4,
      selection: r.selection,
    });
  };
  push('Hash split: A fits, B held out', foldA, foldB);
  push('Hash split: B fits, A held out', foldB, foldA);
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const cut = Math.floor(dated.length / 2);
  push('Time split: older fits, newer held out', dated.slice(0, cut), dated.slice(cut));
  const all = bestInSample(live, snapshot.as_of);
  const model: ModelConstants = {
    growth_weight: all.candidate.growthWeight,
    growth_floor: -60,
    growth_cap: 120,
    maturity_floor: all.candidate.maturityFloor,
    maturity_range: all.candidate.maturityRange,
    maturity_days: 1095,
    unknown_age_days: 365,
    multiple_floor: all.candidate.multipleFloor,
    multiple_cap: all.candidate.multipleCap,
    multiple_min_samples: 3,
  };
  return {
    model,
    report: {
      modelVersion: MODEL_VERSION_FITTED,
      liveFittable: live.length,
      folds,
      finalModel: model,
      fullSampleMedianAbsLogError: Math.round(all.error * 1e4) / 1e4,
      baselineFullSampleMedianAbsLogError: Math.round(all.baselineError * 1e4) / 1e4,
    },
  };
}
