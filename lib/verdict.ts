// radar-3 verdicts: every farm plan carries its cost, and every row carries a verdict.
//
// A farm plan is only worth following when the launch it chases is worth more than the
// farming costs. The cost is the plan's own capital tier plus the gas of its transactions
// on the protocol's chain, both derived from the row's figures, never from a hand-written
// list of names. The verdict weighs the row's expected value — its implied value times its
// launch odds — against that cost, and says plainly whether to farm it first, farm it, farm
// it only with spare capital, or wait.

/** One row's costed verdict: what farming costs, what it is worth, and the call. */
export interface FarmVerdict {
  costUsd: number;
  capitalUsd: number;
  gasUsd: number;
  ratio: number;
  verdict: string;
  reason: string;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 250;
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  return 50;
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

/** A readable dollar figure: whole dollars above a hundred, two decimals below. */
function money(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/** The costed verdict of one row: its expected value against what farming it costs. */
export function farmVerdict(args: {
  implied: number;
  odds: number;
  tvlUsd: number;
  chains: string[];
}): FarmVerdict {
  const capital = capitalFor(args.tvlUsd);
  const chain = args.chains.length > 0 ? args.chains[0]! : 'ethereum';
  // Five priced transactions across the seven steps: two to open, two to deepen, one a week.
  const gas = Math.round(gasPerTx(chain) * 5 * 100) / 100;
  const cost = Math.round((capital + gas) * 100) / 100;
  const expected = Math.max(1, Math.round(args.implied * args.odds));
  const ratio = Math.round((expected / Math.max(cost, 0.01)) * 10) / 10;
  // The bands sit on the board's own spread: expected value runs hundreds to hundreds
  // of thousands of times the farming cost, so the verdict separates the board's top
  // decile from its tail instead of calling everything worth farming.
  let verdict: string;
  let reason: string;
  const times = `~${Math.round(ratio).toLocaleString('en-US')}x the ${money(cost)} it costs to farm`;
  if (ratio >= 50000) {
    verdict = 'Farm first';
    reason = `Expected ${money(expected)} at ${Math.round(args.odds * 100)}% odds is ${times} — the best return on the board.`;
  } else if (ratio >= 10000) {
    verdict = 'Worth farming';
    reason = `Expected ${money(expected)} at ${Math.round(args.odds * 100)}% odds is ${times} — the launch pays for the position many times over.`;
  } else if (ratio >= 1000) {
    verdict = 'Marginal — spare capital only';
    reason = `Expected ${money(expected)} at ${Math.round(args.odds * 100)}% odds is ${times} — worth it only with capital that can wait.`;
  } else {
    verdict = 'Wait — the cost eats the case';
    reason = `Expected ${money(expected)} at ${Math.round(args.odds * 100)}% odds is only ${times} — the position costs too much for what the launch is likely worth.`;
  }
  return { costUsd: cost, capitalUsd: capital, gasUsd: gas, ratio, verdict, reason };
}
