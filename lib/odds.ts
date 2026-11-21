// radar-3 odds: the chance a pre-token protocol launches a token, read off the peers'
// own record — never guessed, never hand-set.
//
// The snapshot is its own history: every protocol in it either has a token (it launched)
// or does not (it has not, yet). Grouped by category and by age with no token, the share
// that has launched is the launch rate for a peer like this one: young protocols almost
// never have tokens, old ones often do, and some categories launch far more than others.
// A pre-token row's odds are that rate, shrunk toward the global rate when its peer group
// is small, so a group of three cannot claim a certainty. The expected value is the row's
// implied value times its odds: what the launch is worth, weighted by whether it happens.

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
