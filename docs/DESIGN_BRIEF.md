# Frontend design brief — orderbook-live

Copy the section between the `---` markers below and send it to Claude Design.
The response should be a single self-contained page (HTML + inline CSS / JS,
or a React component if you prefer — the backend is easily consumed either
way) that I'll drop in as `src/app/*` and wire to the existing `Feed` API.

---

I'm building a live limit-order-book viewer that connects to Coinbase's
public depth feed and lets people probe a real market with a hypothetical
passive order to see how the queue-position models I built in a Python
research project actually behave against live depth. The backend is done
and tested; I need a frontend that does justice to the systems work
underneath rather than looking like a hobbyist crypto chart.

**Audience.** Recruiters and quant/HFT hiring managers looking at my
portfolio. The site has 30 seconds to convince them the code underneath
is serious. Somebody who reads exchange technical docs for a living
should look at this page and think "this person understands what a
limit order book is."

**The one screen.** A single page, no routes, no login. On the left,
depth of book: the top ~15 levels each side, quantities rendered as
horizontal bars scaled to the max size in view. Between them the touch
price and spread, mid, microprice, and an imbalance meter — all
numbers with 3-6 decimals where the venue's grid allows. On the right,
a compact input area: side (bid/ask), price offset from touch, size,
holding-window volume budget. Below it, a probability *range* — not
a single number — showing what fraction of the order fills under each
of three queue models, with a visible bracket between the pessimistic
and optimistic estimate. Below that, a tiny status strip: connection
state, sequence number, gaps detected, messages/sec.

**Aesthetic.** Bloomberg Terminal / trading-desk restraint, not
Robinhood polish. Monospaced numbers throughout. Dense information,
generous whitespace between panels, no gradients, no glassmorphism, no
bright accent colours. Colour used only where colour carries meaning:
bids vs asks (a muted green/red or blue/orange, low saturation), gap /
error states (single amber cue), the fill-probability bracket (a
single accent). Dark theme default, light theme accessible via a
prefers-color-scheme toggle. All motion is functional — depth bars
should animate on size changes short enough that the eye follows them
(150-250ms), status changes shouldn't animate at all. No decorative
transitions.

**Layout constraints.**
- Fluid grid: three columns on desktop (depth-bid | metrics | depth-ask
  with the input panel + fill readout as a right rail), collapsing to
  a single column on mobile with depth first and input last.
- The depth column must remain readable at any width — bars can shrink
  but the price and size columns don't wrap.
- Never scroll horizontally.
- The fill-probability visualization is the hero element that
  distinguishes this from every other order-book viewer online. Give
  it more room than a normal readout would get, and design the bracket
  so the range is obvious at a glance (my instinct: horizontal bar
  from low to high with midpoint marker, but you decide).

**Backend surface (what the page will call).**
```
import { Feed } from "./lib/feed";
import { estimateFill } from "./lib/queue/fill";
import { Instrument, Side } from "./lib/types";

const feed = new Feed({ instrument: BTC, productId: "BTC-USD" });
feed.subscribe({ onState(state) { rerender(state); } });
feed.start();

// state includes: state.book, state.status, state.sync,
//   state.gapsDetected, state.messagesReceived, state.errorMessage
// book has: bestBid(), bestAsk(), spread(), mid(), microprice(),
//   imbalance(depth), levels(side, depth), sizeAt(side, price),
//   lastSequence()

// On the input side:
const range = estimateFill(state.book, {
  side: Side.Bid, price: bestBid - 1, size: 0.05, volumeBudget: 2.0,
});
// range: { low, high, midpoint, perModel: [{ model, fillFraction,
//   queueAhead, lotsNeededForFullFill }], marketable }
```

Sizes/prices in these calls are in integer ticks and lots. The
`Instrument` class formats them back to human strings.

**Not in scope.**
- No trading. This is a viewer.
- No charts of price over time. The whole point is depth, not time
  series.
- No login, no accounts, no persistence.
- No brand or logo — the page's own restraint is the identity.

**Deliverable I need back.**
1. A single `index.html` (or one React component tree in `src/app/App.tsx`
   — either works) with all styles inline or in one file.
2. Whichever framework you use, no runtime dependencies beyond React if
   you go that route. Vanilla is preferred if it doesn't hurt the design.
3. Assume the backend surface above is fixed; if there's data you want
   that isn't there, note it separately rather than inventing the API.
4. Design tokens (colours, spacing, type sizes) at the top of the file
   so I can tweak without touching layout.

That's it. Restraint, information density, and one interaction — the
passive-order probe — that shows what the code underneath is actually
for.

---

## After I have the design

I'll paste the design back here. To integrate it I need to:
1. Drop the HTML/component into `src/app/`.
2. Add a Vite entry (`index.html` + `src/main.ts` or `src/main.tsx`).
3. Wire the `Feed` and `estimateFill` calls into whatever the design
   expects for state.
4. Deploy to Vercel with the free tier.
