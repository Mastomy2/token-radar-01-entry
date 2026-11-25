// radar-5 fit: the value model is one fitted power law, log(market cap) = a + b*log(TVL),
// and nothing else — because the blind tests said so.
//
// The backtester (~/workspace/makefun/token-radar-01-backtest/backtest.py, run 25 Nov 2026
// on the sealed snapshot) compared candidate value models on the same three honest folds
// this file uses (hash split both ways + time split, winner picked on an inner split only):
//   radar-4 (fitted multiples):  held-out median |log error| 1.6796 / 1.3455 / 1.6763 (mean 1.5671)
//   radar-2 (hand-set):          1.6486 / 1.3117 / 1.7756 (mean 1.5787)
//   V1 log-log OLS:              1.2408 / 1.2749 / 1.0974 (mean 1.2044)  <- shipped
//   V2 log-log + growth/age:     1.2350 / 1.3345 / 1.2339 (mean 1.2678)
//   V2 + category intercepts:    1.0005 / 1.3345 / 1.2738 (mean 1.2029)
//   V3 ensemble V2/V0:           1.2910 / 1.1305 / 1.3282 (mean 1.2499)
// The log-log slope is ~0.52: market cap grows with the square root of TVL, not linearly,
// so the old model (implied = TVL x multiple) systematically overpriced the biggest
// protocols and underpriced the small ones. Growth and age terms were tried on the same
// blind folds and DROPPED: they raised held-out error (mean 1.27 vs 1.20), so the shipped
// model uses TVL alone — every term kept or dropped on blind tests, as the dashboard says.
// The fit is done at run time from the snapshot's own live-token protocols; no coefficient
// is hand-set and no protocol name is ever special-cased.

import { fitModel } from './fit.ts';
import type { Snapshot, SnapshotProtocol } from './model.ts';

/** The fitted model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION_FITTED5 = 'radar-5';

/** One fitted power law: log market cap = intercept + slope * log(TVL). */
export interface LogLogModel {
  intercept: number;
  slope: number;
  lambda: number;
}

/** One fold's fit: what was fitted, on how much, and how it did out of sample. */
export interface Fit5Fold {
  fold: string;
  fitSize: number;
  testSize: number;
  lambda: number;
  heldOutMedianAbsLogError: number;
  baselineMedianAbsLogError: number;
  /** Where the fold's lambda was picked: never on the held-out half. */
  selection: string;
}

/** The whole fit: three folds, the final model, and its full-sample error. */
export interface Fit5Report {
  modelVersion: string;
  liveFittable: number;
  folds: Fit5Fold[];
  finalModel: LogLogModel;
  fullSampleMedianAbsLogError: number;
  baselineFullSampleMedianAbsLogError: number;
  /** Why the model has only TVL in it, in one honest sentence for the dashboard. */
  droppedTerms: string;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A deterministic fold for a slug: a small string hash, even or odd. (Same as fit.ts.) */
function foldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 2;
}

/** A second, independent fold for a slug: a position-weighted sum. (Same as fit.ts.) */
function innerFoldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h + slug.charCodeAt(i) * (i + 1)) >>> 0;
  return h % 2;
}

/** The ridge penalties the grid searches (the intercept is never penalised). */
const LAMBDAS = [0, 0.1, 1, 10, 100];

/** Ridge OLS for y = a + b*x on one set, closed form for two parameters. */
function ridgeFit(xs: number[], ys: number[], lambda: number): LogLogModel {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  // Normal equations with the slope penalised by lambda (intercept free):
  //   n*a + sx*b = sy ; sx*a + (sxx + lambda)*b = sxy
  const det = n * (sxx + lambda) - sx * sx;
  const slope = det === 0 ? 0 : (n * sxy - sx * sy) / det;
  const intercept = (sy - slope * sx) / n;
  return { intercept, slope, lambda };
}

/** The median absolute log error of one power law on one set of live protocols. */
function medianAbsLogError(
  test: SnapshotProtocol[],
  model: LogLogModel,
): number {
  const errors: number[] = [];
  for (const p of test) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const predicted = model.intercept + model.slope * Math.log(Math.max(1, p.tvl_usd));
    errors.push(Math.abs(predicted - Math.log(p.mcap_usd)));
  }
  return errors.length > 0 ? median(errors) : Number.POSITIVE_INFINITY;
}

/** The best lambda on one fit set, picked on that set's own inner split — never on the
 *  held-out set the fold will be scored against. */
function selectLambda(
  fitSet: SnapshotProtocol[],
): { lambda: number; selection: string } {
  const innerFit = fitSet.filter((p) => innerFoldOf(p.slug) === 0);
  const innerTest = fitSet.filter((p) => innerFoldOf(p.slug) === 1);
  const usable = innerFit.length > 0 && innerTest.length > 0;
  const pickFrom = usable ? innerTest : fitSet;
  const fitFrom = usable ? innerFit : fitSet;
  const xs = fitFrom.map((p) => Math.log(Math.max(1, p.tvl_usd)));
  const ys = fitFrom.map((p) => Math.log(p.mcap_usd!));
  let best = LAMBDAS[0]!;
  let bestError = Number.POSITIVE_INFINITY;
  for (const lambda of LAMBDAS) {
    const model = ridgeFit(xs, ys, lambda);
    const e = medianAbsLogError(pickFrom, model);
    if (e < bestError) {
      bestError = e;
      best = lambda;
    }
  }
  return {
    lambda: best,
    selection: usable
      ? 'lambda picked on the fit half\u2019s inner split, never on the held-out half'
      : 'lambda picked in-sample: the fit half was too small to split',
  };
}

/** One honest held-out fold: pick lambda on the fit set alone, then score it once,
 *  with the fit set's own fit, on the held-out set it has never met. */
function honestFold(
  label: string,
  fitSet: SnapshotProtocol[],
  testSet: SnapshotProtocol[],
  baselineError: number,
): Fit5Fold {
  const picked = selectLambda(fitSet);
  const xs = fitSet.map((p) => Math.log(Math.max(1, p.tvl_usd)));
  const ys = fitSet.map((p) => Math.log(p.mcap_usd!));
  const model = ridgeFit(xs, ys, picked.lambda);
  return {
    fold: label,
    fitSize: fitSet.length,
    testSize: testSet.length,
    lambda: picked.lambda,
    heldOutMedianAbsLogError: Math.round(medianAbsLogError(testSet, model) * 1e4) / 1e4,
    baselineMedianAbsLogError: baselineError,
    selection: picked.selection,
  };
}

/** The predicted log market cap of one protocol under the power law. */
export function predictLogMcap(p: SnapshotProtocol, model: LogLogModel): number {
  return model.intercept + model.slope * Math.log(Math.max(1, p.tvl_usd));
}

/** The implied value of one pre-token protocol: the power law's median prediction. */
export function impliedValue5(p: SnapshotProtocol, model: LogLogModel): number {
  return Math.max(1, Math.round(Math.exp(predictLogMcap(p, model))));
}

/** The fitted power law and its report: two held-out folds from one hash split (each half
 *  fits, the other is held out), a third from an independent time split (older protocols
 *  fit, newer ones are held out), then a final fit on all live protocols. The baseline
 *  column is the radar-4 fitted model on the same folds, from fit.ts. */
export function fitLogLog(snapshot: Snapshot): { model: LogLogModel; report: Fit5Report } {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const old = fitModel(snapshot);
  // fit.ts's folds carry two error columns: heldOutMedianAbsLogError is radar-4's own
  // error and baselineMedianAbsLogError is radar-2's. The baseline column here is
  // radar-4, the model being replaced, so it reads the held-out column.
  const radar4ByFold = new Map(old.report.folds.map((f) => [f.fold, f.heldOutMedianAbsLogError]));
  const foldA = live.filter((p) => foldOf(p.slug) === 0);
  const foldB = live.filter((p) => foldOf(p.slug) === 1);
  const folds: Fit5Fold[] = [];
  const push = (label: string, fitSet: SnapshotProtocol[], testSet: SnapshotProtocol[]): void => {
    folds.push(honestFold(label, fitSet, testSet, radar4ByFold.get(label) ?? Number.NaN));
  };
  push('Hash split: A fits, B held out', foldA, foldB);
  push('Hash split: B fits, A held out', foldB, foldA);
  const dated = live
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const cut = Math.floor(dated.length / 2);
  push('Time split: older fits, newer held out', dated.slice(0, cut), dated.slice(cut));
  const picked = selectLambda(live);
  const xs = live.map((p) => Math.log(Math.max(1, p.tvl_usd)));
  const ys = live.map((p) => Math.log(p.mcap_usd!));
  const model = ridgeFit(xs, ys, picked.lambda);
  const fullError = medianAbsLogError(live, model);
  return {
    model,
    report: {
      modelVersion: MODEL_VERSION_FITTED5,
      liveFittable: live.length,
      folds,
      finalModel: model,
      fullSampleMedianAbsLogError: Math.round(fullError * 1e4) / 1e4,
      baselineFullSampleMedianAbsLogError: old.report.fullSampleMedianAbsLogError,
      droppedTerms:
        'Growth and age terms were tried on the same blind folds and dropped: they raised ' +
        'held-out error (mean 1.27 vs 1.20), so the value uses TVL alone.',
    },
  };
}
