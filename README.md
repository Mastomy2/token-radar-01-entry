# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Mastomy2/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Mastomy2/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar — a dashboard that finds pre-token protocols, ranks them by implied value, and shows how to farm each one. Built for make.fun's "Build the best token launch radar" bounty from a sealed DefiLlama snapshot (2026-11-14).

## The model (radar-2)

- **Clean board only:** every ranked protocol is pre-token and is not a wrapped, staked or bridged product of a token that already trades. The watchlist's exclusion rules apply to all 198 rows, not just the 40 on the watchlist.
- **Category multiples from the market:** each category is scored at the median market-cap / TVL of that category's live-token protocols, computed from the snapshot at run time (clamped to 0.05–1.00; categories with fewer than 3 live comparables use the global median, 0.205x).
- **Implied value:** `TVL × category multiple × growth multiplier × maturity multiplier`, where growth is the 7-day TVL change (clamped −60% to +120%) and maturity grows with the time the protocol has run with no token.
- **Farm plans:** 7 concrete steps per protocol, with chain-aware gas costs and a hold window, derived from the protocol's category, chains, TVL and age.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
# then open out/dashboard/index.html (it reads out/data.js; no network)
```

## Files

- `main.ts` — reads the snapshot, scores the board, writes `board.json`, `data.js`, `dashboard/` and `dossier.json`.
- `lib/model.ts` — the radar-2 model, the farm plans and the board validation.
- `dashboard/` — the static dashboard (`index.html`, `app.css`, `app.js`).
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
- `screenshots/` — board, detail and filtered views.

---

<sub>Entered on [make.fun](https://make.fun/?ref=94ztz8n6&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
