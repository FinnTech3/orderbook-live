import { describe, expect, it } from "vitest";
import { OrderBook } from "../src/lib/book.js";
import { estimateFill } from "../src/lib/queue/fill.js";
import { Instrument, Side } from "../src/lib/types.js";
import type { PriceSize, Snapshot } from "../src/lib/types.js";

const INSTRUMENT = new Instrument("TEST", "1", "1");

function bookAt(bids: PriceSize[], asks: PriceSize[]): OrderBook {
  const book = new OrderBook(INSTRUMENT);
  const snap: Snapshot = { sequence: 1, eventTimeMs: 0, bids, asks };
  book.loadSnapshot(snap);
  return book;
}

describe("estimateFill — marketable orders", () => {
  it("a market buy at the ask fills against available depth", () => {
    const book = bookAt([{ price: 99, size: 5 }], [{ price: 100, size: 8 }]);
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 100,
      size: 5,
      volumeBudget: 0,
    });
    expect(range.marketable).toBe(true);
    // Ask has 8, we want 5 → fully filled.
    expect(range.low).toBe(1);
    expect(range.high).toBe(1);
    // All three models agree when marketable.
    for (const e of range.perModel) expect(e.fillFraction).toBe(1);
  });

  it("a marketable order larger than the touch partials", () => {
    const book = bookAt([{ price: 99, size: 5 }], [{ price: 100, size: 3 }]);
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 101, // clearly crosses
      size: 10,
      volumeBudget: 0,
    });
    expect(range.marketable).toBe(true);
    // Only the touch is consumed here — we don't walk the book beyond it.
    expect(range.low).toBeCloseTo(0.3, 6);
  });

  it("crossing an empty other side returns zero", () => {
    const book = bookAt([{ price: 99, size: 5 }], []);
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 200,
      size: 1,
      volumeBudget: 0,
    });
    expect(range.marketable).toBe(false); // no ask → not marketable
    expect(range.low).toBe(0);
  });
});

describe("estimateFill — passive orders", () => {
  it("counts existing size at the price as queue ahead", () => {
    const book = bookAt(
      [{ price: 99, size: 10 }],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 4,
      volumeBudget: 0,
    });
    for (const e of range.perModel) {
      expect(e.queueAhead).toBe(10);
      expect(e.lotsNeededForFullFill).toBe(14); // 10 ahead + 4 order
    }
  });

  it("counts strictly-better prices as ahead too", () => {
    // Place at 97 on the bid side; 99 and 98 are strictly better.
    const book = bookAt(
      [
        { price: 99, size: 3 },
        { price: 98, size: 2 },
        { price: 97, size: 5 },
      ],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 97,
      size: 1,
      volumeBudget: 0,
    });
    for (const e of range.perModel) {
      expect(e.queueAhead).toBe(3 + 2 + 5); // 99 + 98 + 97
    }
  });

  it("zero budget means zero fill regardless of queue", () => {
    const book = bookAt(
      [{ price: 99, size: 10 }],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 4,
      volumeBudget: 0,
    });
    expect(range.low).toBe(0);
    expect(range.high).toBe(0);
  });

  it("large budget saturates the fill", () => {
    const book = bookAt(
      [{ price: 99, size: 2 }],
      [{ price: 101, size: 5 }],
    );
    // 2 ahead + 4 order = 6 lots. Budget 100 covers it under any model.
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 4,
      volumeBudget: 100,
    });
    for (const e of range.perModel) expect(e.fillFraction).toBe(1);
  });

  it("pessimistic ≤ optimistic in the passive case", () => {
    const book = bookAt(
      [{ price: 99, size: 100 }],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 10,
      volumeBudget: 60,
    });
    const byModel = Object.fromEntries(range.perModel.map((e) => [e.model, e.fillFraction]));
    expect(byModel["pessimistic"]!).toBeLessThanOrEqual(byModel["optimistic"]!);
    expect(range.low).toBe(byModel["pessimistic"]);
    expect(range.high).toBe(byModel["optimistic"]);
  });

  it("midpoint is the average of low and high", () => {
    const book = bookAt(
      [{ price: 99, size: 50 }],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 5,
      volumeBudget: 30,
    });
    expect(range.midpoint).toBeCloseTo((range.low + range.high) / 2, 9);
  });

  it("ask-side placement mirrors bid-side arithmetic", () => {
    const book = bookAt(
      [{ price: 99, size: 5 }],
      [{ price: 101, size: 8 }],
    );
    const range = estimateFill(book, {
      side: Side.Ask,
      price: 101,
      size: 2,
      volumeBudget: 0,
    });
    for (const e of range.perModel) expect(e.queueAhead).toBe(8);
  });

  it("zero-size order returns zero fill, not NaN", () => {
    const book = bookAt(
      [{ price: 99, size: 10 }],
      [{ price: 101, size: 5 }],
    );
    const range = estimateFill(book, {
      side: Side.Bid,
      price: 99,
      size: 0,
      volumeBudget: 100,
    });
    for (const e of range.perModel) expect(e.fillFraction).toBe(0);
    expect(Number.isFinite(range.midpoint)).toBe(true);
  });
});
