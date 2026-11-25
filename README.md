# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Mastomy2/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Mastomy2/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar — a dashboard that finds pre-token protocols, ranks them by implied value, and shows how to farm each one. Built for make.fun's "Build the best token launch radar" bounty from a sealed DefiLlama snapshot (2026-11-14).

## The model (radar-5)

- **Clean board only:** every ranked protocol is pre-token and is not a wrapped, staked or bridged product of a token that already trades. The watchlist's exclusion rules apply to all 198 rows, not just the 40 on the watchlist.
- **One fitted power law:** `log(market cap) = 7.151 + 0.512 × log(TVL)`, ridge-fitted on the snapshot's 128 live-token protocols at run time — market cap grows with the square root of TVL, not linearly, so the old multiples model (implied = TVL × category multiple) systematically overpriced the biggest protocols. Held-out median log error 1.2408 / 1.2749 / 1.0974 across three blind folds vs 1.6796 / 1.3455 / 1.6763 for the old model. Growth and age terms were tried on the same blind folds and dropped: they raised held-out error, so the value uses TVL alone.
- **Launch odds from a Weibull clock:** forward 12-month launch chance from a Weibull distribution of launch ages fitted on the snapshot's own record (shape 0.755, scale 6,606 days). Held-out Brier score 0.1476 vs 0.1609 for the peer-group rate.
- **Farm plans:** 7 concrete steps per protocol, each with its cost and time, with chain-aware gas costs and a hold window, derived from the protocol's category, chains, TVL and age. Every step carries a dollar cost, including the $0 ones.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
# then open out/dashboard/index.html (it reads out/data.js; no network)
```

## Files

- `main.ts` — reads the snapshot, scores the board, writes `board.json`, `data.js`, `dashboard/` and `dossier.json`.
- `lib/model.ts` — the radar-5 model, the farm plans and the board validation.
- `lib/fit5.ts` — the fitted power law and its honest held-out folds.
- `lib/odds.ts` — the Weibull launch clock and the peer table it beat.
- `dashboard/` — the static dashboard (`index.html`, `app.css`, `app.js`).
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
- `screenshots/` — board, detail and filtered views.

---

<sub>Entered on [make.fun](https://make.fun/?ref=94ztz8n6&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
