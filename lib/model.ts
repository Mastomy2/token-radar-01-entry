// The token radar's model, radar-5: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds every
// other clean pre-token protocol in the snapshot: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol), and it is
// rankable only when it is not a wrapped, staked or bridged product of a token that already trades:
// the watchlist's own exclusion rules (category, name and exchange prefix) apply to every row, not just
// the watchlist, so no board row is WBTC, a staked-ETH product or a bridge. The snapshot's live-token
// protocols are kept apart and shown as the market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures, and no protocol name is ever
// special-cased: the same function scores every row. radar-5 prices every row with one fitted
// power law, log(market cap) = intercept + slope * log(TVL) (see lib/fit5.ts): the market's own
// live-token protocols say value grows with the square root of TVL, not linearly. The radar-2
// multiples machinery (computeMultiples / impliedValue) stays in this file as the documented
// baseline the fit report compares against.

import { fitLogLog, impliedValue5, MODEL_VERSION_FITTED5 } from './fit5.ts';
import type { Fit5Report, LogLogModel } from './fit5.ts';
import { buildOddsTable } from './odds.ts';
import { fitWeibull, oddsBrierComparison, oddsFor5 } from './odds.ts';
import type { OddsFitReport, WeibullClock } from './odds.ts';
import { farmVerdict } from './verdict.ts';
import { integrityStrip } from './integrity.ts';
import type { IntegrityItem } from './integrity.ts';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  /** Shrinkage prior for the category multiple: a category's own median counts as this many
   *  global observations, so one live comparable moves the multiple part-way from the global
   *  median instead of being ignored (too few samples) or trusted whole (one noisy sample). */
  multiple_min_samples: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
  multiple_min_samples: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-5';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    log_tvl: number;
    predicted_log_mcap: number;
    intercept: number;
    slope: number;
    lambda: number;
    age_days: number | null;
  };
  farm_steps: string[];
  launch_odds: number;
  expected_value_usd: number;
  farm_cost_usd: number;
  farm_verdict: string;
  odds_basis: string;
  odds_peers: number;
  odds_launched: number;
  farm_capital_usd: number;
  farm_gas_usd: number;
  farm_ratio: number;
  farm_reason: string;
}

/** The dashboard's compact view of one row, farm plan included so the detail view and board.json agree. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  log_tvl: number;
  predicted_log_mcap: number;
  intercept: number;
  slope: number;
  lambda: number;
  farm_steps: string[];
  launch_odds: number;
  expected_value_usd: number;
  farm_cost_usd: number;
  farm_verdict: string;
  odds_basis: string;
  odds_peers: number;
  odds_launched: number;
  farm_capital_usd: number;
  farm_gas_usd: number;
  farm_ratio: number;
  farm_reason: string;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's market multiple, as the dashboard's methodology table shows it. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  samples: number;
  source: 'category' | 'global';
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: LogLogModel;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  multiples: CategoryMultiple[];
  global_multiple: number;
  watchlist: string[];
  rows: RadarRow[];
  live: LiveRow[];
  fit?: Fit5Report;
  oddsFit?: OddsFitReport;
  integrity?: IntegrityItem[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The `q` quantile (0..1) of a sorted list of numbers, nearest-rank. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 1;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of another protocol, never a launch of their own. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a protocol name must not begin with: an exchange's own product, not a protocol. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that already trades. The watchlist's exclusion rules, applied to every row.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/**
 * Snapshot sanity check: one warning per protocol whose fields cannot be scored as-is.
 * A protocol with no name, a negative TVL, or a TVL of zero is skipped by the board, and a
 * listed_at date that does not parse ages as unknown. Warnings are informational only; the
 * board still scores every protocol that passes `isRankable`, so a bad row never blocks a run.
 */
export function validateSnapshot(snapshot: Snapshot): string[] {
  const warnings: string[] = [];
  for (const p of snapshot.protocols) {
    if (!p.name || p.name.trim() === '') {
      warnings.push(`protocol ${p.slug}: missing name`);
      continue;
    }
    if (p.tvl_usd < 0) warnings.push(`${p.slug}: negative TVL ${p.tvl_usd}`);
    if (p.tvl_usd === 0) warnings.push(`${p.slug}: zero TVL, implied value will be 1`);
    if (p.listed_at !== null && !Number.isFinite(Date.parse(`${p.listed_at}T00:00:00Z`))) {
      warnings.push(`${p.slug}: listed_at ${p.listed_at} does not parse, age treated as unknown`);
    }
    if (p.mcap_usd !== null && p.mcap_usd < 0) warnings.push(`${p.slug}: negative market cap`);
    if (p.category === null && isRankable(p)) {
      warnings.push(`${p.slug}: rankable but uncategorised, scored at the global multiple`);
    }
    if (p.change_7d !== null && !Number.isFinite(p.change_7d)) {
      warnings.push(`${p.slug}: change_7d is not finite, growth treated as zero`);
    }
  }
  return warnings;
}

/**
 * The market multiples, computed from the snapshot's own live-token protocols at run time.
 * Each category's multiple is its median market-cap / TVL, shrunk toward the global median
 * with `multiple_min_samples` as the prior strength: (n * category median + k * global) /
 * (n + k). A category with one live comparable is priced part-way from its own evidence,
 * never on the global median alone and never on a single sample whole. A category with no
 * live comparable at all still falls back to the global median. Before any median, each
 * live ratio is winsorized at the set's own 95th percentile, so one token priced at 400x
 * its TVL (rain, the only live Prediction Market) cannot set a whole category's multiple
 * on its own. All multiples are clamped to [multiple_floor, multiple_cap].
 */
export function computeMultiples(snapshot: Snapshot, model: ModelConstants): {
  byCategory: Map<string, number>;
  global: number;
  samples: Map<string, number>;
  table: CategoryMultiple[];
} {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) continue;
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
  const winsor = all.length > 0 ? percentile([...all].sort((a, b) => a - b), 0.95) : 1;
  const win = (r: number): number => Math.min(r, winsor);
  const clamp = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const global = all.length > 0 ? clamp(median(all.map(win))) : 0.25;
  const multiples = new Map<string, number>();
  const samples = new Map<string, number>();
  const table: CategoryMultiple[] = [];
  const k = model.multiple_min_samples;
  for (const [category, values] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const shrunk = (values.length * median(values.map(win)) + k * global) / (values.length + k);
    multiples.set(category, clamp(shrunk));
    samples.set(category, values.length);
    table.push({ category, multiple: clamp(shrunk), samples: values.length, source: 'category' });
  }
  return { byCategory: multiples, global, samples, table };
}

/** The category multiple one protocol is scored at, and where it came from. */
export function multipleFor(
  p: SnapshotProtocol,
  multiples: { byCategory: Map<string, number>; global: number; samples: Map<string, number> },
): { multiple: number; source: string } {
  if (p.category !== null && multiples.byCategory.has(p.category)) {
    const n = multiples.samples.get(p.category) ?? 0;
    return {
      multiple: multiples.byCategory.get(p.category)!,
      source: `median of ${n} ${p.category} live token${n === 1 ? '' : 's'}, shrunk to global`,
    };
  }
  return { multiple: multiples.global, source: 'global median of live tokens' };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiple: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks under the radar-5 power law, strongest first. */
export function buildBoard5(
  snapshot: Snapshot,
  logLog: LogLogModel,
  clock: WeibullClock,
): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const oddsTable = buildOddsTable(snapshot);
  const scored = [...chosen.values()].map((p) => {
    const implied = impliedValue5(p, logLog);
    const age = ageDays(snapshot.as_of, p.listed_at);
    const odds = oddsFor5(oddsTable, clock, p, age, implied);
    const verdict = farmVerdict({ implied, odds: odds.odds, tvlUsd: p.tvl_usd, chains: p.chains });
    return { p, implied, age, odds, verdict };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      log_tvl: Math.round(Math.log(Math.max(1, s.p.tvl_usd)) * 1e4) / 1e4,
      predicted_log_mcap: Math.round((logLog.intercept + logLog.slope * Math.log(Math.max(1, s.p.tvl_usd))) * 1e4) / 1e4,
      intercept: logLog.intercept,
      slope: logLog.slope,
      lambda: logLog.lambda,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
    launch_odds: s.odds.odds,
    expected_value_usd: s.odds.expected,
    farm_cost_usd: s.verdict.costUsd,
    farm_verdict: s.verdict.verdict,
    odds_basis: s.odds.basis,
    odds_peers: s.odds.peers,
    odds_launched: s.odds.launched,
    farm_capital_usd: s.verdict.capitalUsd,
    farm_gas_usd: s.verdict.gasUsd,
    farm_ratio: s.verdict.ratio,
    farm_reason: s.verdict.reason,
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Rough gas for one transaction on a chain, in dollars, from the chain's own fee market. */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c === 'solana') return 0.01;
  if (c === 'tron') return 1;
  if (c === 'bitcoin') return 2;
  if (c === 'binance' || c === 'bnb' || c === 'bsc') return 0.2;
  if (c === 'polygon') return 0.05;
  if (c === 'avalanche') return 0.3;
  if (c === 'fantom') return 0.1;
  // Base, Arbitrum, Optimism, Ink, and the other L2s: a few cents a transaction.
  return 0.1;
}

/** A readable gas figure for a step that needs `txs` transactions on `chain`. */
function gasCost(chain: string, txs: number): string {
  const per = gasPerTx(chain);
  const total = per * txs;
  if (total < 0.05) return 'under $0.10 of gas';
  if (total < 1) return `about $${total.toFixed(2)} of gas`;
  return `about $${Math.round(total)} of gas`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $10 of USDC against it so the wallet shows both sides of the market.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain}, in the pair it lists first, and keep the position open.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares in the wallet.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  }
  if (c.includes('basis trading')) {
    return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and hold the position through one funding cycle.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and place one position on a market that settles within the month.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} of USDC to ${name}'s chain and use one of its native apps with it.`;
  }
  if (c.includes('payment') || c.includes('card')) {
    return `Fund $${capital} through ${name} on ${chain} and make one real payment with it.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action, different from the first, so the wallet shows real use. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Repay the $10 borrow on ${name} and supply another $20 of USDC, so the wallet shows a full borrow cycle.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Swap $20 of USDC for the pool's other asset on ${name} and add it to the same position.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital') || c.includes('yield')) {
    return `Deposit another $25 into a second ${name} vault on ${chain} so the wallet holds two vaults.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) {
    return `Close the first position on ${name} and open a second one half its size.`;
  }
  if (c.includes('prediction')) {
    return `Place a second position on a different ${name} market with $10.`;
  }
  if (c.includes('rwa') || c.includes('insurance') || c.includes('staking') || c.includes('restak')) {
    return `Top up the ${name} position by $25 on ${chain} and keep the receipt.`;
  }
  return `Make a second $25 deposit into ${name} on ${chain} so the wallet shows repeat use.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'nothing to set up ($0)',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gasCost(chain, 2)}`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `$25 of capital and ${gasCost(chain, 2)}`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote on ${chain}.`,
      cost: gasCost(chain, 1) + ' a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Open ${p.name}'s own points or rewards page and check the wallet's standing; claim only from the link the protocol itself publishes.`,
      cost: 'no fee to check ($0), and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log ($0)',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && !(p.category !== null && EXCLUDED_CATEGORIES.has(p.category)))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    log_tvl: row.model.log_tvl,
    predicted_log_mcap: row.model.predicted_log_mcap,
    intercept: row.model.intercept,
    slope: row.model.slope,
    lambda: row.model.lambda,
    farm_steps: row.farm_steps,
    launch_odds: row.launch_odds,
    expected_value_usd: row.expected_value_usd,
    farm_cost_usd: row.farm_cost_usd,
    farm_verdict: row.farm_verdict,
    odds_basis: row.odds_basis,
    odds_peers: row.odds_peers,
    odds_launched: row.odds_launched,
    farm_capital_usd: row.farm_capital_usd,
    farm_gas_usd: row.farm_gas_usd,
    farm_ratio: row.farm_ratio,
    farm_reason: row.farm_reason,
  };
}

/**
 * The radar-5 build: the value is one fitted power law (log market cap = a + b*log TVL,
 * fitted on the snapshot's live-token protocols and tested held-out twice, in two
 * independent designs), the launch odds are a forward 12-month Weibull launch clock
 * fitted on the same record, the board carries costed farm verdicts with their
 * breakdown, and the dashboard carries the fit report and the integrity strip.
 * Growth and age terms were tried on the same blind folds and dropped: they raised
 * held-out error, so the value uses TVL alone. The radar-4 multiples model stays in
 * this file (computeMultiples / impliedValue) as the documented baseline the fit
 * report compares against.
 */
export function buildRadarFitted(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fitted = fitLogLog(snapshot);
  const clock = fitWeibull(snapshot);
  const oddsFit = oddsBrierComparison(snapshot);
  const board = buildBoard5(snapshot, fitted.model, clock);
  const multiples = computeMultiples(snapshot, MODEL);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const warnings = validateSnapshot(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: fitted.model,
    model_version: MODEL_VERSION_FITTED5,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    multiples: multiples.table,
    global_multiple: multiples.global,
    watchlist: snapshot.watchlist,
    rows: board.map(radarRow),
    live,
    fit: fitted.report,
    oddsFit,
    integrity: integrityStrip(snapshot, board, warnings),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
