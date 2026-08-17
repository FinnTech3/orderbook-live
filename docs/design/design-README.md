# Handoff: Live Limit-Order-Book Viewer + Passive-Order Probe

## Overview
Single-screen, no-route viewer for a live Coinbase L2 depth feed (`BTC-USD`), plus one interaction:
a **hypothetical passive order probe** that reports the fraction of the order expected to fill under
three queue-position models, shown as a **range bracket** rather than a single number.
Audience is quant/HFT hiring managers; the design goal is trading-desk restraint and information
density, not consumer crypto polish.

## About the Design Files
`Order Book Probe.dc.html` is a **design reference created in HTML** - a working prototype showing
intended look, density, motion, and behavior. It is **not production code to copy directly**.
The task is to recreate this design in the target codebase's environment (React/TS is the obvious
fit here) using its existing patterns. `support.js` is only the prototype's runtime shim; discard it.

Two things in the prototype are **stand-ins that must be deleted** on integration:
- `class SimBook` - a local simulated book. Replace with the real `Feed` from `./lib/feed`.
- `function estimateFill(...)` - a local stub. Replace with `estimateFill` from `./lib/queue/fill`.

Both were written to the fixed backend surface below, so the render layer needs no changes:

```ts
const feed = new Feed({ instrument: BTC, productId: "BTC-USD" });
feed.subscribe({ onState(state) { rerender(state); } });
feed.start();
// state: book, status, sync, gapsDetected, messagesReceived, errorMessage
// book:  bestBid(), bestAsk(), spread(), mid(), microprice(),
//        imbalance(depth), levels(side, depth), sizeAt(side, price), lastSequence()
const range = estimateFill(state.book, { side, price, size, volumeBudget });
// range: { low, high, midpoint, marketable, perModel: [{ model, fillFraction,
//          queueAhead, lotsNeededForFullFill }] }
```
Prices/sizes are integer ticks/lots (`TICK = 0.01 USD`, `LOT = 0.0001 BTC` in the prototype);
`Instrument` formats them back to strings.

## Fidelity
**High-fidelity.** Colors, type scale, spacing, densities, and motion timings are final and listed
below. Recreate pixel-for-pixel; substitute only where the codebase has an equivalent primitive.

## Screens / Views

One screen, three stacked bands inside a centered column (`max-width: 1680px`, page padding `16px`,
`gap: 12px`, `overflow-x: hidden`, `min-height: 100vh`).

### 1. Header (full width, `border-bottom: 1px solid --line`, `padding-bottom: 12px`)
Left, baseline-aligned row (`gap: 16px`): product id `BTC-USD` (13px/700, `--text-hi`, `letter-spacing .04em`);
`COINBASE · LEVEL 2 · AGGREGATED DEPTH` (10.5px, `--dim`, uppercase, `.12em`);
`TICK 0.01 · LOT 0.0001` (10.5px, `--dim-2`).
Right: UTC clock `HH:MM:SSZ` (10.5px, `--dim`) and a theme toggle button
(transparent, `1px solid --line-2`, `5px 10px`, 10.5px uppercase; hover → `--text-hi` text + border).

### 2. Book band - grid `minmax(0,1fr) 190px minmax(0,1fr)`, `gap: 12px`, `align-items: start`

**Bid panel** (`--panel` bg, `1px solid --line`, `padding: 12px`)
- Column header row, grid `1fr 1fr 1fr`, 10.5px uppercase `--dim`, `.12em`, `border-bottom: 1px solid --line`, `padding-bottom: 6px`: `BIDS` (colored `--bid`, left) / `SIZE` (right) / `PRICE` (right).
- Rows: `height: 24px`, grid `1fr 1fr 1fr`, `gap: 8px`, 13px.
  Order left→right: cumulative size (12px, `--dim-2`), size (`--text`), price (`--bid`, weight 700 on the touch row).
  Depth bar: absolutely positioned, `top/bottom: 1px`, **anchored right** (grows toward the mid column),
  `background: --bid-bar`, `width = 100 * size / maxSizeInView %`,
  `transition: width 190ms cubic-bezier(.2,.6,.3,1)`.
  Probe marker: 2px `--accent` vertical rule at the row's inner edge when that price === probe price.

**Ask panel** - mirror image: header `PRICE / SIZE / ASKS` (`ASKS` colored `--ask`, right),
row order price / size / cumulative, bar **anchored left**, `--ask-bar`.

**Metrics column** (190px, `--panel`, `padding: 12px`, flex column, `gap: 16px`)
- `SPREAD` label + `$0.02` at 30px `--text-hi`; sub-line `2 ticks · 0.003 bps` (10.5px `--dim`).
- `MID` + 20px value; `MICROPRICE` + 20px value (4 dp) + `±0.0000 vs mid` sub-line.
- `IMBALANCE` block (`border-top: 1px solid --line`, `padding-top: 12px`): right-hand depth label `10L`;
  8px track (`--panel-2`, `1px solid --line`) with a `--bid` fill at 55% opacity
  (`width = bidRatio`, same 190ms transition) and a 1px `--line-2` center tick overhanging 3px top/bottom;
  below, three values 13px: bid % (`--bid`), signed imbalance (`--text-hi`), ask % (`--ask`).
- Totals block (`border-top`): `BID DEPTH`, `ASK DEPTH`, `LEVELS` rows, 10.5px label / `--text` value.

**Level count is viewport-driven**: `depth = clamp(floor((innerHeight - 620) / 24), 10, 26)`
(recomputed on resize) unless the `depthLevels` prop overrides it. This keeps the band ending near the
fold instead of leaving a short column on tall displays.

### 3. Probe + fill band - grid `minmax(320px,400px) minmax(0,1fr)`, `gap: 12px`, `align-items: stretch`

**Passive order probe** (left panel, flex column, `gap: 12px`)
- Title row: `PASSIVE ORDER PROBE` (10.5px, `--text-hi`, `.14em`) / `HYPOTHETICAL · NOT SENT` (9.5px, `--dim-2`).
- `SIDE`: 2-up segmented control inside `1px solid --line-2`; selected = `--bid-bar`/`--ask-bar` bg with
  `--bid`/`--ask` text; unselected = transparent + `--dim`. Labels `BID` / `ASK`, 12px, `.14em`, `7px 0`.
- `OFFSET FROM TOUCH` (right-hand hint `TICKS`): grid `34px 1fr 34px`; `−` / `+` buttons on `--panel-2`
  with 1px dividers (hover → `--line` bg, `--text-hi`); center shows signed offset (13px `--text-hi`)
  and `@ 64,122.95` (10.5px `--dim`). Clamped 0 to 40 ticks. Default **2**.
- Two inputs side by side (`ORDER SIZE` default `0.0500`, `VOLUME BUDGET` default `2.0000`):
  `--panel-2` bg, `1px solid --line-2`, `7px 8px`, 13px, focus border `--accent`, no outline.
  Sub-captions 9.5px `--dim-2`: `500 lots BTC` / `traded through level, holding window`.

**Expected fill fraction - the hero** (right panel, grid `minmax(0,1.1fr) minmax(0,1fr)`, `gap: 24px`, `padding: 16px`)

*Left cell:*
- Title row: `EXPECTED FILL FRACTION` / status chip `PASSIVE · RESTING` (`--dim-2`) or
  `MARKETABLE - WOULD CROSS` (`--amber`).
- Midpoint number at 46px `--text-hi`, `line-height: .9`, with `MIDPOINT ESTIMATE` and
  `range 48.6% - 96.1%` (12px `--accent`) baseline-aligned beside it.
- **Bracket**, `position: relative; height: 86px`:
  - axis rule: full-width 2px `--line` at `top: 26px`;
  - range band: `top: 14px`, `height: 26px`, `background: --accent-soft`,
    `border-left/right: 2px solid --accent`, `left = low%`, `width = max(high-low, .4)%`;
  - midpoint marker: 1px `--accent`, `top: 6px`, `height: 42px`, `left = midpoint%`;
  - end labels at `top: 44px`, `translateX(-50%)`, positions clamped to 6 to 94%, shown **only when the
    range is ≥24% wide**; below that a single merged `low - high` label centered at `clamp(mid, 14, 86)%`;
  - axis ticks at the bottom: `0% 25 50 75 100%`, 9.5px `--dim-2`, space-between;
  - all bracket geometry transitions `190ms ease`.

*Right cell:* model table, `border-top: 1px solid --line`, grid `1.5fr 68px 1fr 1fr`, `gap: 8px`.
Header 9.5px uppercase `--dim`: `QUEUE MODEL / FILL / QUEUE AHEAD / LOTS TO FILL`.
Three rows (`padding: 9px 0`, `border-bottom: 1px solid --line`): model name (12px `--text-hi`) with a
9.5px `--dim-2` note beneath, fill % (13px `--text-hi`, right), queue ahead in BTC (3 dp), lots to fill.
Models and notes, in order:
1. `FIFO / no cancellation` - *lower bound · queue only drains by trades*
2. `Uniform cancellation` - *κ=0.55 · cancels spread evenly over queue*
3. `Front-loaded cancel` - *γ=0.80 · cancels concentrate at queue head*

Footnote paragraph, 9.5px `--dim-2`, `line-height: 1.7`, explaining that the bracket spans the
pessimistic and optimistic models and that the budget is discounted by distance from touch.

### 4. Status strip (footer, `border-top: 1px solid --line`, `padding-top: 10px`, flex-wrap, `gap: 24px`)
10.5px uppercase `--dim`, `.1em`: a 6×6px square dot + `CONNECTED` (`--bid`) / `CONNECTING` (`--amber`);
`SEQ <n>`, `GAPS <n>` (turns `--amber` when > 0), `MSGS <n>`, `<n> MSG/S`, `BOOK AGE <n>s`,
and an `--amber` error message slot fed by `state.errorMessage`. **No transitions on this strip** - status changes must be instant.

## Interactions & Behavior
- Side toggle, offset ±, size and budget text inputs → recompute `estimateFill` on the current book snapshot every render.
- The book re-renders on every feed state push (prototype ticks at 120ms); depth bars and the imbalance
  fill animate `190ms`; everything else is instant. No decorative transitions anywhere.
- Marketable probe (bid ≥ best ask, or ask ≤ best bid) → all models report 100%, chip flips to amber.
- Probe price is highlighted in the depth ladder with a 2px accent rule on the matching row.
- Responsive: ≤1100px the probe/hero band and the hero's own two cells collapse to one column;
  ≤720px the book collapses to a single column with the metrics column last. Never scrolls horizontally.
- Theme: dark by default, `@media (prefers-color-scheme: light)` supplies the light palette, and the
  header button forces either via `data-theme="dark" | "light"` on the root.

## State Management
- Feed-owned: `book`, `status`, `sync`, `gapsDetected`, `messagesReceived`, `errorMessage` (from `feed.subscribe`).
- UI-owned: `side` (`bid` default), `offset` (ticks, default 2), `sizeInput` (`"0.0500"`),
  `budgetInput` (`"2.0000"`), `theme`, `vh` (viewport height, for the level count).
- Derived per render: probe price, `estimateFill(...)` result, formatted metrics, msgs/sec
  (count over a rolling 1s window).
- No persistence, no routing, no auth.

## Design Tokens
Defined once at the top of the file as CSS custom properties; light values are the second column.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0a0c0d` | `#f2f1ee` |
| `--panel` | `#0f1214` | `#fbfaf8` |
| `--panel-2` | `#131719` | `#f4f3f0` |
| `--line` | `#1f2528` | `#dedbd4` |
| `--line-2` | `#2b3236` | `#c9c5bc` |
| `--text` | `#c7d0d3` | `#2b3033` |
| `--text-hi` | `#eef3f4` | `#101315` |
| `--dim` | `#6a7679` | `#6f7679` |
| `--dim-2` | `#4a5457` | `#9aa0a2` |
| `--bid` | `#4f8f6b` | `#2f6b4c` |
| `--bid-bar` | `rgba(79,143,107,.17)` | `rgba(47,107,76,.13)` |
| `--ask` | `#b0645a` | `#96473c` |
| `--ask-bar` | `rgba(176,100,90,.17)` | `rgba(150,71,60,.13)` |
| `--amber` | `#c99a3a` | `#8a6512` |
| `--accent` | `#7396c4` | `#33557f` |
| `--accent-soft` | `rgba(115,150,196,.16)` | `rgba(51,85,127,.14)` |

Spacing: `--s1 4 / --s2 8 / --s3 12 / --s4 16 / --s5 24 / --s6 36` (px).
Type: `--t-micro 9.5 / --t-label 10.5 / --t-body 12 / --t-num 13 / --t-lg 20 / --t-xl 30 / --t-hero 46` (px).
Radius: **0 everywhere**. Shadows: **none**. Gradients: **none**.
Font: JetBrains Mono 400/500/700, `font-variant-numeric: tabular-nums` on the root.
Motion: `190ms cubic-bezier(.2,.6,.3,1)` for depth/imbalance widths, `190ms ease` for bracket geometry, nothing else.

## Assets
None. No logo, no icons, no images - the restraint is the identity.
Only external asset is the JetBrains Mono webfont (Google Fonts); self-host it in production.

## Data not in the backend surface
Worth adding server-side; the design works without it:
1. **Order count per level** - would allow a real `ORDERS` column and better queue-ahead realism.
2. **`tradedVolumeAt(side, price, windowMs)`** or a trade tape - the volume budget is currently typed by the user rather than observed.
3. **Exchange timestamp on the book** - `BOOK AGE` in the status strip is derived client-side today.

## Files
- `Order Book Probe.dc.html` - the full design (markup + logic + tokens) in one file.
- `support.js` - prototype runtime only; not part of the design, do not port.
