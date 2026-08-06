import { describe, expect, it } from "vitest";
import { CrossedBookError, OrderBook } from "../src/lib/book.js";
import { Instrument, Side } from "../src/lib/types.js";
import type { DepthDelta, PriceSize, Snapshot } from "../src/lib/types.js";

const INSTRUMENT = new Instrument("TEST", "1", "1");

function level(price: number, size: number): PriceSize { return { price, size }; }

function snapshot(bids: PriceSize[], asks: PriceSize[], sequence = 100, when = 1_000): Snapshot {
  return { sequence, eventTimeMs: when, bids, asks };
}

function delta(
  sequence: number,
  bids: PriceSize[] = [],
  asks: PriceSize[] = [],
  when = sequence * 10,
  previous: number | null = sequence - 1,
): DepthDelta {
  return { sequence, previousSequence: previous, eventTimeMs: when, bids, asks };
}

describe("OrderBook", () => {
  it("loads a snapshot into both sides", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5), level(98, 3)], [level(101, 4), level(102, 6)]));
    expect(book.bestBid()).toBe(99);
    expect(book.bestAsk()).toBe(101);
    expect(book.spread()).toBe(2);
    expect(book.lastSequence()).toBe(100);
  });

  it("snapshot replaces rather than merges", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5)], [level(101, 4)]));
    book.loadSnapshot(snapshot([level(90, 1)], [level(110, 1)], 200));
    expect(book.bestBid()).toBe(90);
    expect(book.bestAsk()).toBe(110);
    expect(book.bids.size()).toBe(1);
    expect(book.lastSequence()).toBe(200);
  });

  it("delta updates and removes levels", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5), level(98, 3)], [level(101, 4)]));
    book.applyDelta(delta(101, [level(99, 0), level(97, 9)], [level(101, 7)]));
    expect(book.bestBid()).toBe(98);
    expect(book.sizeAt(Side.Bid, 97)).toBe(9);
    expect(book.sizeAt(Side.Ask, 101)).toBe(7);
    expect(book.lastSequence()).toBe(101);
  });

  it("empty side yields null for the derived metrics", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5)], []));
    expect(book.bestAsk()).toBeNull();
    expect(book.spread()).toBeNull();
    expect(book.mid()).toBeNull();
    expect(book.microprice()).toBeNull();
  });

  it("a crossed book raises", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5)], [level(101, 4)]));
    expect(() => book.applyDelta(delta(101, [level(102, 1)]))).toThrow(CrossedBookError);
  });

  it("touching prices count as crossed", () => {
    const book = new OrderBook(INSTRUMENT);
    expect(() => book.loadSnapshot(snapshot([level(100, 1)], [level(100, 1)]))).toThrow(CrossedBookError);
  });

  it("a transient cross inside one delta is allowed", () => {
    // The single message that both lifts the bid and moves the ask must
    // not fail — the book is fine once the whole message is applied.
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5)], [level(101, 4)]));
    book.applyDelta(delta(101, [level(102, 3)], [level(101, 0), level(103, 2)]));
    expect(book.bestBid()).toBe(102);
    expect(book.bestAsk()).toBe(103);
  });

  it("mid can be a half-tick", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(100, 1)], [level(101, 1)]));
    expect(book.mid()).toBe(100.5);
  });

  it("microprice leans away from the heavy side", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(100, 10)], [level(101, 1)]));
    // 10 lots bid vs 1 lot ask → next trade likely at ask, so
    // microprice > mid.
    expect(book.microprice()!).toBeGreaterThan(book.mid()!);
    expect(book.microprice()).toBe((101 * 10 + 100 * 1) / 11);
  });

  it("microprice equals mid when balanced", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(100, 7)], [level(101, 7)]));
    expect(book.microprice()).toBe(book.mid());
  });

  it("imbalance is in [-1, 1] and correctly signed", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(100, 10)], [level(101, 1)]));
    expect(book.imbalance(1)!).toBeGreaterThan(0.8);
    expect(book.imbalance(1)!).toBeLessThanOrEqual(1);
  });

  it("levels returns depth best-first", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot(
      [level(99, 1), level(98, 2), level(97, 3)],
      [level(101, 4), level(102, 5)],
    ));
    expect(book.levels(Side.Bid, 2)).toEqual([level(99, 1), level(98, 2)]);
    expect(book.levels(Side.Ask, 5)).toEqual([level(101, 4), level(102, 5)]);
  });

  it("clear resets metadata", () => {
    const book = new OrderBook(INSTRUMENT);
    book.loadSnapshot(snapshot([level(99, 5)], [level(101, 4)]));
    book.clear();
    expect(book.bestBid()).toBeNull();
    expect(book.lastSequence()).toBeNull();
    expect(book.eventTimeMs()).toBeNull();
  });
});
