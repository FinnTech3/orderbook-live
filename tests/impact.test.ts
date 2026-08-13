import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/lib/book.js";
import { costToMove, depthCurve, slippageFraction, sweep } from "../src/lib/impact.js";
import { Instrument, Side } from "../src/lib/types.js";
import type { PriceSize, Snapshot } from "../src/lib/types.js";

const INSTRUMENT = new Instrument("TEST", "1", "1");
const level = (price: number, size: number): PriceSize => ({ price, size });

function bookOf(bids: PriceSize[], asks: PriceSize[]): OrderBook {
  const book = new OrderBook(INSTRUMENT);
  const snap: Snapshot = { sequence: 1, eventTimeMs: 0, bids, asks };
  book.loadSnapshot(snap);
  return book;
}

// Asks: 101×4, 102×6, 103×10.  Bids: 99×5, 98×3, 97×8.  Mid = 100.
const BOOK = () => bookOf(
  [level(99, 5), level(98, 3), level(97, 8)],
  [level(101, 4), level(102, 6), level(103, 10)],
);

describe("sweep", () => {
  it("a buy that fits in the touch pays the touch price", () => {
    const s = sweep(BOOK(), Side.Bid, 4);
    expect(s.filledSize).toBe(4);
    expect(s.vwap).toBe(101);
    expect(s.slippageTicks).toBe(1); // 101 − mid 100
    expect(s.levelsConsumed).toBe(1);
    expect(s.exhausted).toBe(false);
  });

  it("a buy that walks two levels reports the blended VWAP", () => {
    const s = sweep(BOOK(), Side.Bid, 8);
    // (101×4 + 102×4) / 8 = 101.5
    expect(s.vwap).toBe(101.5);
    expect(s.slippageTicks).toBe(1.5);
    expect(s.levelsConsumed).toBe(2);
  });

  it("a sell walks the bids and slips the other way", () => {
    const s = sweep(BOOK(), Side.Ask, 5);
    expect(s.vwap).toBe(99);
    expect(s.slippageTicks).toBe(1); // mid 100 − 99
  });

  it("flags exhaustion when the order is bigger than the book", () => {
    const s = sweep(BOOK(), Side.Bid, 100);
    expect(s.filledSize).toBe(20); // 4 + 6 + 10
    expect(s.exhausted).toBe(true);
    // (101×4 + 102×6 + 103×10) / 20 = 102.3
    expect(s.vwap).toBeCloseTo(102.3, 9);
  });

  it("bigger orders slip more (monotonic impact)", () => {
    const small = sweep(BOOK(), Side.Bid, 4).slippageTicks!;
    const big = sweep(BOOK(), Side.Bid, 18).slippageTicks!;
    expect(big).toBeGreaterThan(small);
  });

  it("nothing to fill against an empty side", () => {
    const s = sweep(bookOf([level(99, 5)], []), Side.Bid, 3);
    expect(s.filledSize).toBe(0);
    expect(s.vwap).toBeNull();
    expect(s.slippageTicks).toBeNull();
    expect(s.exhausted).toBe(true);
  });
});

describe("slippageFraction", () => {
  it("expresses slippage as a fraction of the mid", () => {
    // 1 tick of slippage on a mid of 100 → 0.01 (100 bps).
    expect(slippageFraction(BOOK(), Side.Bid, 4)).toBeCloseTo(0.01, 9);
  });
});

describe("costToMove", () => {
  it("sums the liquidity below the target price for a buy", () => {
    // Move the ask up 1 tick (to 102): must clear 101×4.
    expect(costToMove(BOOK(), Side.Bid, 1)).toEqual({ lots: 4, notional: 404, reachable: true });
    // Up 2 ticks (to 103): clear 101×4 + 102×6 = 10.
    expect(costToMove(BOOK(), Side.Bid, 2)).toEqual({ lots: 10, notional: 404 + 612, reachable: true });
  });

  it("mirrors on the sell side", () => {
    // Move the bid down 1 tick (to 98): clear 99×5.
    expect(costToMove(BOOK(), Side.Ask, 1)).toEqual({ lots: 5, notional: 495, reachable: true });
  });

  it("reports unreachable when the book is too thin to confirm the move", () => {
    // Target 104 is past the deepest ask (103): consume all, still unconfirmed.
    const r = costToMove(BOOK(), Side.Bid, 3);
    expect(r.lots).toBe(20);
    expect(r.reachable).toBe(false);
  });

  it("is zero for a non-positive move", () => {
    expect(costToMove(BOOK(), Side.Bid, 0).lots).toBe(0);
  });
});

describe("depthCurve", () => {
  it("accumulates size and notional best-first", () => {
    const curve = depthCurve(BOOK(), Side.Ask, 3);
    expect(curve.map((p) => p.cumulativeSize)).toEqual([4, 10, 20]);
    expect(curve.map((p) => p.cumulativeNotional)).toEqual([404, 1016, 2046]);
  });
});
