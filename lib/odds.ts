// radar-5 odds: the chance a pre-token protocol launches a token in the next 12 months,
// read off a Weibull launch clock fitted on the snapshot's own record — never guessed,
// never hand-set.
//
// The snapshot is its own history: every protocol in it either has a token (it launched)
// or does not (it has not, yet). The clock is the distribution of launch ages: a Weibull
// fitted by maximum likelihood on current-status data (launched by this age, or not yet),
// so a protocol that survived 400 days with no token gets the forward chance of the
// survivors like it, not the raw share of its age group. Held out on two hash folds, the
// clock beats the old peer-group rate on Brier score (0.1476 vs 0.1609, lower is better).
// The peer table stays in this file as the fallback for protocols with no known age and
// as the comparison the clock beat. The expected value is the row's implied value times
// its odds: what the launch is worth, weighted by whether it happens.

import type { Snapshot, SnapshotProtocol } from './model.ts';

/** One peer group: how many protocols it holds, and how many of them have a token. */
export interface PeerGroup {
  total: number;
  launched: number;
}

/** The launch rates, by category and age bucket, plus the global rate they shrink toward. */
export interface OddsTable {
  globalRate: number;
  globalTotal: number;
  globalLaunched: number;
  byCategory: Map<string, PeerGroup>;
  byCategoryAge: Map<string, PeerGroup>;
}

/** One row's odds: the rate, the peers behind it, and the expected value. */
export interface LaunchOdds {
  odds: number;
  expected: number;
  peers: number;
  launched: number;
  basis: string;
}

/** The fitted Weibull launch clock: the distribution of ages at which protocols launch. */
export interface WeibullClock {
  shape: number;
  scale: number;
  logLik: number;
  fittedOn: number;
}

/** The held-out Brier comparison between the peer table and the Weibull clock. */
export interface OddsFitReport {
  folds: Array<{ fold: string; peerBrier: number; weibullBrier: number }>;
  peerMean: number;
  weibullMean: number;
}

/** A deterministic fold for a slug: a small string hash, even or odd. (Same as fit.ts.) */
function foldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 2;
}

/** The Weibull CDF at age `a` days: the share of protocols launched by then. */
function weibullCdf(a: number, shape: number, scale: number): number {
  if (a <= 0) return 0;
  return 1 - Math.exp(-Math.pow(a / scale, shape));
}

/** The clock's prediction that a protocol has launched by its current age: the CDF
 *  itself. This is the quantity the Brier comparison scores, because the peer table
 *  predicts the same thing (launched by now) — the board shows the forward 12-month
 *  version of the same clock, which is a different quantity and cannot be scored
 *  against the launched-by-now label. */
export function weibullCdfOdds(clock: WeibullClock, age: number | null): number | null {
  if (age === null) return null;
  return Math.min(1, Math.max(0, Math.round(weibullCdf(Math.max(age, 1), clock.shape, clock.scale) * 1e4) / 1e4));
}

/** The negative log-likelihood of current-status launch data under one Weibull clock:
 *  a launched protocol contributes log F(age), an unlaunched one log(1 - F(age)). */
function weibullNll(
  ages: number[],
  launched: number[],
  shape: number,
  scale: number,
): number {
  let nll = 0;
  for (let i = 0; i < ages.length; i++) {
    const f = Math.min(1 - 1e-9, Math.max(1e-9, weibullCdf(Math.max(ages[i]!, 1), shape, scale)));
    nll -= launched[i] === 1 ? Math.log(f) : Math.log(1 - f);
  }
  return nll;
}

/** The Weibull launch clock, fitted by maximum likelihood on the snapshot's own record:
 *  every protocol with a known age is one current-status observation — launched by its
 *  age, or not yet. Grid search, then a fine pass around the best point: deterministic,
 *  no optimiser, no hand-set shape or scale. */
export function fitWeibull(snapshot: Snapshot): WeibullClock {
  const ages: number[] = [];
  const launched: number[] = [];
  for (const p of snapshot.protocols) {
    const a = ageOf(snapshot.as_of, p.listed_at);
    if (a === null) continue;
    ages.push(Math.max(a, 1));
    launched.push(p.mcap_usd !== null ? 1 : 0);
  }
  let best = { shape: 1, scale: 1000, nll: Number.POSITIVE_INFINITY };
  const scan = (k0: number, k1: number, kStep: number, l0: number, l1: number, lSteps: number): void => {
    for (let k = k0; k <= k1 + 1e-9; k += kStep) {
      for (let i = 0; i < lSteps; i++) {
        const scale = l0 * Math.pow(l1 / l0, i / (lSteps - 1));
        const nll = weibullNll(ages, launched, k, scale);
        if (nll < best.nll) best = { shape: Math.round(k * 1e4) / 1e4, scale: Math.round(scale), nll };
      }
    }
  };
  scan(0.3, 2.5, 0.05, 200, 20000, 60);
  scan(Math.max(0.05, best.shape - 0.05), best.shape + 0.05, 0.005, best.scale * 0.9, best.scale * 1.1, 21);
  return { shape: best.shape, scale: best.scale, logLik: Math.round(-best.nll * 10) / 10, fittedOn: ages.length };
}

/** The forward 12-month launch odds for a protocol that survived `age` days with no
 *  token: P(launch in the next year | survived this long). Null when the age is unknown. */
export function weibullForwardOdds(clock: WeibullClock, age: number | null): number | null {
  if (age === null) return null;
  const a = Math.max(age, 1);
  const survived = 1 - weibullCdf(a, clock.shape, clock.scale);
  if (survived <= 0) return 1;
  const forward = (weibullCdf(a + 365, clock.shape, clock.scale) - weibullCdf(a, clock.shape, clock.scale)) / survived;
  return Math.min(1, Math.max(0, Math.round(forward * 1e4) / 1e4));
}

/** The Brier score of one set of predicted launch probabilities against what happened. */
function brierScore(preds: number[], labels: number[]): number {
  if (preds.length === 0) return Number.NaN;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i]! - labels[i]!) ** 2;
  return Math.round((s / preds.length) * 1e4) / 1e4;
}

/** The honest held-out Brier comparison: peer table vs Weibull clock, each fitted on one
 *  hash half of the protocols and scored once on the half it never met. */
export function oddsBrierComparison(snapshot: Snapshot): OddsFitReport {
  const folds: Array<{ fold: string; peerBrier: number; weibullBrier: number }> = [];
  for (const [label, fitHalf, testHalf] of [
    ['Hash split: A fits, B held out', 0, 1],
    ['Hash split: B fits, A held out', 1, 0],
  ] as const) {
    const fitProtos = snapshot.protocols.filter((p) => foldOf(p.slug) === fitHalf);
    const testProtos = snapshot.protocols.filter((p) => foldOf(p.slug) === testHalf);
    const fitSnap: Snapshot = { ...snapshot, protocols: fitProtos };
    const table = buildOddsTable(fitSnap);
    const clock = fitWeibull(fitSnap);
    const peerPreds: number[] = [];
    const weibullPreds: number[] = [];
    const labels: number[] = [];
    for (const p of testProtos) {
      const age = ageOf(snapshot.as_of, p.listed_at);
      const peer = oddsFor(table, p, age, 1);
      const cdf = weibullCdfOdds(clock, age);
      peerPreds.push(peer.odds);
      weibullPreds.push(cdf === null ? table.globalRate : cdf);
      labels.push(p.mcap_usd !== null ? 1 : 0);
    }
    folds.push({
      fold: label,
      peerBrier: brierScore(peerPreds, labels),
      weibullBrier: brierScore(weibullPreds, labels),
    });
  }
  return {
    folds,
    peerMean: Math.round((folds.reduce((s, f) => s + f.peerBrier, 0) / folds.length) * 1e4) / 1e4,
    weibullMean: Math.round((folds.reduce((s, f) => s + f.weibullBrier, 0) / folds.length) * 1e4) / 1e4,
  };
}

/** One pre-token protocol's launch odds from the Weibull clock: the forward 12-month
 *  chance given it survived this long with no token. Falls back to the peer table when
 *  the age is unknown. The peer rate is named in the basis so the reader can compare. */
export function oddsFor5(
  table: OddsTable,
  clock: WeibullClock,
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
): LaunchOdds {
  const peer = oddsFor(table, p, age, implied);
  const forward = weibullForwardOdds(clock, age);
  if (forward === null) return peer;
  const odds = forward;
  const pct = Math.round(odds * 1000) / 10;
  const peerPct = Math.round(peer.odds * 1000) / 10;
  return {
    odds,
    expected: Math.max(1, Math.round(implied * odds)),
    peers: peer.peers,
    launched: peer.launched,
    basis:
      `Weibull launch clock (shape ${clock.shape}, scale ${clock.scale}d): ` +
      `of protocols that survived ${age ?? 0} days with no token, ${pct}% launch in the next 12 months ` +
      `(peer rate for the same group: ${peerPct}%).`,
  };
}

/** The age buckets the peers are grouped in, in days with no token. */
const AGE_BUCKETS: Array<[number, number, string]> = [
  [0, 180, '0-180d'],
  [180, 365, '180-365d'],
  [365, 730, '1-2y'],
  [730, Number.POSITIVE_INFINITY, '2y+'],
];

/** The bucket an age falls in, or null when the age is unknown. */
function bucketOf(age: number | null): [number, number, string] | null {
  if (age === null) return null;
  for (const b of AGE_BUCKETS) if (age >= b[0] && age < b[1]) return b;
  return AGE_BUCKETS[AGE_BUCKETS.length - 1]!;
}

/** The key of one peer group: category, or category plus age bucket. */
function groupKey(category: string | null, bucket: [number, number, string] | null): string {
  return `${category ?? 'Other'}|${bucket === null ? 'all' : bucket[2]}`;
}

/** A rate shrunk toward the global rate: a small group cannot claim a certainty. */
function shrunkRate(group: PeerGroup, globalRate: number): number {
  return (group.launched + 3 * globalRate) / (group.total + 3);
}

/** The launch rates of the snapshot's own record, by category and by category and age. */
export function buildOddsTable(snapshot: Snapshot): OddsTable {
  const byCategory = new Map<string, PeerGroup>();
  const byCategoryAge = new Map<string, PeerGroup>();
  let globalTotal = 0;
  let globalLaunched = 0;
  for (const p of snapshot.protocols) {
    const launched = p.mcap_usd !== null ? 1 : 0;
    globalTotal += 1;
    globalLaunched += launched;
    const catKey = groupKey(p.category, null);
    const cat = byCategory.get(catKey) ?? { total: 0, launched: 0 };
    cat.total += 1;
    cat.launched += launched;
    byCategory.set(catKey, cat);
    const age = ageOf(snapshot.as_of, p.listed_at);
    const bucket = bucketOf(age);
    if (bucket !== null) {
      const key = groupKey(p.category, bucket);
      const g = byCategoryAge.get(key) ?? { total: 0, launched: 0 };
      g.total += 1;
      g.launched += launched;
      byCategoryAge.set(key, g);
    }
  }
  return {
    globalRate: globalTotal > 0 ? globalLaunched / globalTotal : 0,
    globalTotal,
    globalLaunched,
    byCategory,
    byCategoryAge,
  };
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageOf(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** One pre-token protocol's launch odds from the peers' record, and its expected value. */
export function oddsFor(
  table: OddsTable,
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
): LaunchOdds {
  const bucket = bucketOf(age);
  const catKey = groupKey(p.category, null);
  const category = table.byCategory.get(catKey);
  let group: PeerGroup | undefined;
  let basis: string;
  if (bucket !== null) {
    const key = groupKey(p.category, bucket);
    const g = table.byCategoryAge.get(key);
    if (g !== undefined && g.total >= 5) {
      group = g;
      basis = `${g.launched} of ${g.total} ${p.category ?? 'Other'} peers aged ${bucket[2]} have tokens`;
    } else if (category !== undefined && category.total >= 5) {
      group = category;
      basis = `${category.launched} of ${category.total} ${p.category ?? 'Other'} peers have tokens (age group too small)`;
    } else {
      group = { total: table.globalTotal, launched: table.globalLaunched };
      basis = `${table.globalLaunched} of ${table.globalTotal} protocols have tokens (peer group too small)`;
    }
  } else if (category !== undefined && category.total >= 5) {
    group = category;
    basis = `${category.launched} of ${category.total} ${p.category ?? 'Other'} peers have tokens (age unknown)`;
  } else {
    group = { total: table.globalTotal, launched: table.globalLaunched };
    basis = `${table.globalLaunched} of ${table.globalTotal} protocols have tokens (peer group too small)`;
  }
  const odds = Math.round(shrunkRate(group, table.globalRate) * 1e4) / 1e4;
  return {
    odds,
    expected: Math.max(1, Math.round(implied * odds)),
    peers: group.total,
    launched: group.launched,
    basis,
  };
}
