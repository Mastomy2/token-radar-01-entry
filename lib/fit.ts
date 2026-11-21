// radar-3 fit: every value term of the radar's model is fitted from the snapshot's own
// live-token protocols, and tested held-out twice — never hand-set.
//
// The live-token protocols are the model's only ground truth: their market cap is a fact,
// so the model that prices pre-token protocols can be scored against it. The fit predicts
// log market cap for a live protocol from its own TVL, category multiple, 7-day growth and
// age, exactly the arithmetic the board uses, and searches the value terms (growth weight,
// maturity floor and range, multiple clamp) for the smallest median absolute log error.
//
// Held out, twice: the live protocols split into two folds by a hash of their slug. Each
// fold is fitted on one half and tested on the other, so the report carries two honest
// out-of-sample errors, not one in-sample fit. The final model is fitted on all live
// protocols. The hand-set radar-2 constants are scored on the same folds, so the report
// says how much the fit actually buys.

import type { ModelConstants, Snapshot, SnapshotProtocol } from './model.ts';

/** The fitted model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION_FITTED = 'radar-3';

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

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageDaysOf(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** The category multiples of one set of live protocols: median market-cap / TVL per category. */
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
  const global = all.length > 0 ? median(all) : 0.25;
  const multiples = new Map<string, number>();
  for (const [category, values] of byCategory.entries()) {
    if (values.length >= 3) multiples.set(category, median(values));
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

/** The best candidate on one fit set, judged by its error on one test set. */
function bestOn(
  fitSet: SnapshotProtocol[],
  testSet: SnapshotProtocol[],
  asOf: string,
): { candidate: Candidate; error: number; baselineError: number } {
  const multiples = multiplesOf(fitSet);
  let best: Candidate = GRID[0]!;
  let bestError = Number.POSITIVE_INFINITY;
  for (const c of GRID) {
    const e = medianAbsLogError(
      testSet,
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
  const baselineError = medianAbsLogError(
    testSet,
    asOf,
    multiples,
    BASELINE.growthWeight,
    BASELINE.maturityFloor,
    BASELINE.maturityRange,
    BASELINE.multipleFloor,
    BASELINE.multipleCap,
  );
  return { candidate: best, error: bestError, baselineError };
}

/** The fitted model and its report: two held-out folds, then a final fit on all live protocols. */
export function fitModel(snapshot: Snapshot): { model: ModelConstants; report: FitReport } {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const foldA = live.filter((p) => foldOf(p.slug) === 0);
  const foldB = live.filter((p) => foldOf(p.slug) === 1);
  const folds: FoldResult[] = [];
  const ab = bestOn(foldA, foldB, snapshot.as_of);
  folds.push({
    fold: 'A fits, B held out',
    fitSize: foldA.length,
    testSize: foldB.length,
    growthWeight: ab.candidate.growthWeight,
    maturityFloor: ab.candidate.maturityFloor,
    maturityRange: ab.candidate.maturityRange,
    multipleFloor: ab.candidate.multipleFloor,
    multipleCap: ab.candidate.multipleCap,
    heldOutMedianAbsLogError: Math.round(ab.error * 1e4) / 1e4,
    baselineMedianAbsLogError: Math.round(ab.baselineError * 1e4) / 1e4,
  });
  const ba = bestOn(foldB, foldA, snapshot.as_of);
  folds.push({
    fold: 'B fits, A held out',
    fitSize: foldB.length,
    testSize: foldA.length,
    growthWeight: ba.candidate.growthWeight,
    maturityFloor: ba.candidate.maturityFloor,
    maturityRange: ba.candidate.maturityRange,
    multipleFloor: ba.candidate.multipleFloor,
    multipleCap: ba.candidate.multipleCap,
    heldOutMedianAbsLogError: Math.round(ba.error * 1e4) / 1e4,
    baselineMedianAbsLogError: Math.round(ba.baselineError * 1e4) / 1e4,
  });
  const all = bestOn(live, live, snapshot.as_of);
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
