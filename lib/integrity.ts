// radar-5 integrity: the strip across the top of the board that says what the data
// survived, computed from the snapshot and the board at run time — never asserted.
//
// A radar is only as good as the record it stands on, so the dashboard shows its checks
// where the reader looks first: the watchlist is fully covered, no two rows claim one
// ticker, every row's age and pricing source is accounted for, and the snapshot's own
// staleness is stated. A check that fails shows as a warning, not a silence.

import type { BoardRow, Snapshot } from './model.ts';

/** One check on the strip: its name, whether it passed, and the figure behind it. */
export interface IntegrityItem {
  label: string;
  status: 'pass' | 'warn';
  detail: string;
}

/** The integrity strip of one run: coverage, uniqueness, pricing sources, age and staleness. */
export function integrityStrip(
  snapshot: Snapshot,
  board: BoardRow[],
  warnings: string[],
): IntegrityItem[] {
  const slugs = new Set(board.map((r) => r.slug));
  const covered = snapshot.watchlist.filter((s) => slugs.has(s)).length;
  const seenSymbols = new Map<string, number>();
  let duplicateSymbols = 0;
  let unknownAge = 0;
  let offLaw = 0;
  for (const row of board) {
    if (row.symbol !== null) {
      const key = row.symbol.trim().toUpperCase();
      if (seenSymbols.has(key)) duplicateSymbols += 1;
      else seenSymbols.set(key, row.rank);
    }
    if (row.age_days === null) unknownAge += 1;
    const expected = Math.max(
      1,
      Math.round(Math.exp(row.model.intercept + row.model.slope * Math.log(Math.max(1, row.tvl_usd)))),
    );
    if (expected !== row.implied_value_usd) offLaw += 1;
  }
  const asOf = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  const ageDays = Number.isFinite(asOf)
    ? Math.max(0, Math.floor((Date.now() - asOf) / 86_400_000))
    : -1;
  const unknownGrowth = board.filter((r) => r.change_7d === null).length;
  const globalOdds = board.filter((r) => !r.odds_basis.startsWith('Weibull')).length;
  const watchRows = board.filter((r) => snapshot.watchlist.includes(r.slug));
  const watchMinTvl = watchRows.reduce(
    (m, r) => Math.min(m, r.tvl_usd),
    Number.POSITIVE_INFINITY,
  );
  const items: IntegrityItem[] = [
    {
      label: 'Watchlist covered',
      status: covered === snapshot.watchlist.length ? 'pass' : 'warn',
      detail: `${covered} of ${snapshot.watchlist.length} watchlist protocols on the board`,
    },
    {
      label: 'Symbols unique',
      status: duplicateSymbols === 0 ? 'pass' : 'warn',
      detail:
        seenSymbols.size === 0
          ? 'no board row carries a ticker yet, so no two rows can claim one'
          : duplicateSymbols === 0
            ? `${seenSymbols.size} tickers, no row shares one`
            : `${duplicateSymbols} duplicate ticker${duplicateSymbols === 1 ? '' : 's'} on the board`,
    },
    {
      label: 'Ages known',
      status: unknownAge === 0 ? 'pass' : 'warn',
      detail:
        unknownAge === 0
          ? 'every row carries its age with no token'
          : `${unknownAge} of ${board.length} rows have an unknown age`,
    },
    {
      label: 'Priced by one law',
      status: offLaw === 0 ? 'pass' : 'warn',
      detail:
        offLaw === 0
          ? 'every row\u2019s implied value is the fitted power law at its TVL'
          : `${offLaw} of ${board.length} rows differ from the fitted power law`,
    },
    {
      label: 'Growth known',
      status: unknownGrowth === 0 ? 'pass' : 'warn',
      detail:
        unknownGrowth === 0
          ? 'every row reports its 7-day growth'
          : `${unknownGrowth} of ${board.length} rows report no 7-day growth; shown as n/a, the value model uses TVL alone`,
    },
    {
      label: 'Odds from the clock',
      status: globalOdds === 0 ? 'pass' : 'warn',
      detail:
        globalOdds === 0
          ? 'every row\u2019s launch odds come from the Weibull clock'
          : `${globalOdds} of ${board.length} rows fall back to the peer rate (age unknown); the rest use the Weibull clock`,
    },
    {
      label: 'Snapshot fresh',
      status: ageDays >= 0 && ageDays <= 30 ? 'pass' : 'warn',
      detail:
        ageDays < 0
          ? 'the snapshot carries no usable date'
          : `snapshot dated ${snapshot.as_of}, ${ageDays} day${ageDays === 1 ? '' : 's'} old at run time`,
    },
    {
      label: 'Rows clean',
      status: warnings.length === 0 ? 'pass' : 'warn',
      detail:
        warnings.length === 0
          ? `all ${snapshot.protocols.length} protocols scored without a warning`
          : `${warnings.length} snapshot warning${warnings.length === 1 ? '' : 's'}: ${warnings.slice(0, 2).join('; ')}`,
    },
    {
      label: 'TVL floor held',
      status: watchMinTvl >= snapshot.floor_usd ? 'pass' : 'warn',
      detail: `smallest watchlist TVL $${Math.round(watchMinTvl).toLocaleString('en-US')} against a $${Math.round(snapshot.floor_usd).toLocaleString('en-US')} floor for the watchlist`,
    },
  ];
  return items;
}
