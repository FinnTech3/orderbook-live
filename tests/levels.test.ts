import { describe, expect, it } from "vitest";
import { PriceLevels, lowerBound } from "../src/lib/levels.js";
import { Side } from "../src/lib/types.js";

/** Deliberately naive levels, sorts on every read. Obviously correct.
 *  Used as an oracle for the differential test. */
class ReferenceLevels {
  private readonly sizes = new Map<number, number>();
  constructor(readonly side: Side) {}
  set(price: number, size: number): void {
    if (size === 0) this.sizes.delete(price);
    else this.sizes.set(price, size);
  }
  best(): number | null {
    if (this.sizes.size === 0) return null;
    const prices = [...this.sizes.keys()];
    return this.side === Side.Bid ? Math.max(...prices) : Math.min(...prices);
  }
  size(): number { return this.sizes.size; }
}

describe("PriceLevels", () => {
  it("empty has no best price", () => {
    expect(new PriceLevels(Side.Bid).best()).toBeNull();
    expect(new PriceLevels(Side.Ask).best()).toBeNull();
  });

  it("bid best is the highest price", () => {
    const levels = new PriceLevels(Side.Bid);
    for (const p of [100, 103, 101]) levels.set(p, 5);
    expect(levels.best()).toBe(103);
  });

  it("ask best is the lowest price", () => {
    const levels = new PriceLevels(Side.Ask);
    for (const p of [100, 103, 101]) levels.set(p, 5);
    expect(levels.best()).toBe(100);
  });

  it("zero size removes the level", () => {
    const levels = new PriceLevels(Side.Bid);
    levels.set(100, 5);
    levels.set(101, 7);
    levels.set(101, 0);
    expect(levels.best()).toBe(100);
    expect(levels.size()).toBe(1);
  });

  it("removing an absent level is a no-op", () => {
    const levels = new PriceLevels(Side.Ask);
    levels.set(100, 3);
    levels.set(999, 0);
    expect(levels.size()).toBe(1);
    levels.checkInvariants();
  });

  it("resizing does not duplicate a price", () => {
    const levels = new PriceLevels(Side.Bid);
    levels.set(100, 5); levels.set(100, 9); levels.set(100, 1);
    expect(levels.size()).toBe(1);
    expect(levels.sizeAt(100)).toBe(1);
    expect(levels.pricesAscending()).toEqual([100]);
  });

  it("negative size is rejected", () => {
    expect(() => new PriceLevels(Side.Bid).set(100, -1)).toThrow();
  });

  it("top returns depth best-first, correct on both sides", () => {
    const bids = new PriceLevels(Side.Bid);
    for (const [p, s] of [[98, 1], [99, 2], [100, 3], [101, 4]]) bids.set(p!, s!);
    expect(bids.top(2)).toEqual([{ price: 101, size: 4 }, { price: 100, size: 3 }]);

    const asks = new PriceLevels(Side.Ask);
    for (const [p, s] of [[102, 1], [103, 2], [104, 3]]) asks.set(p!, s!);
    expect(asks.top(2)).toEqual([{ price: 102, size: 1 }, { price: 103, size: 2 }]);
  });

  it("top handles depth beyond available", () => {
    const levels = new PriceLevels(Side.Bid);
    levels.set(100, 1);
    expect(levels.top(50)).toEqual([{ price: 100, size: 1 }]);
    expect(levels.top(0)).toEqual([]);
    expect(levels.top(-1)).toEqual([]);
  });

  it("depthWithin sums cumulative size near the touch", () => {
    const bids = new PriceLevels(Side.Bid);
    for (const [p, s] of [[95, 10], [98, 5], [99, 3], [100, 2]]) bids.set(p!, s!);
    expect(bids.depthWithin(0)).toBe(2);
    expect(bids.depthWithin(1)).toBe(5);
    expect(bids.depthWithin(5)).toBe(20);
    expect(bids.depthWithin(100)).toBe(20);
  });

  it("sizeAhead for a passive bid counts all its own price and better", () => {
    const bids = new PriceLevels(Side.Bid);
    for (const [p, s] of [[95, 10], [98, 5], [99, 3]]) bids.set(p!, s!);
    // Placing at 99 (the touch): everything at 99 is ahead (5 no, wait,
    // 3 at 99). Nothing strictly better than 99 exists.
    expect(bids.sizeAhead(99)).toBe(3);
    // Placing at 98: everything at 98 and everything at 99 is ahead.
    expect(bids.sizeAhead(98)).toBe(5 + 3);
    // Placing above the touch is marketable, returns null.
    expect(bids.sizeAhead(100)).toBeNull();
  });

  it("clear empties both structures", () => {
    const levels = new PriceLevels(Side.Bid);
    for (let p = 100; p < 110; p++) levels.set(p, 1);
    levels.clear();
    expect(levels.size()).toBe(0);
    expect(levels.best()).toBeNull();
    levels.checkInvariants();
  });

  it("agrees with the naive oracle over random operations (bid)", () => {
    differentialTest(Side.Bid);
  });

  it("agrees with the naive oracle over random operations (ask)", () => {
    differentialTest(Side.Ask);
  });
});

describe("lowerBound", () => {
  it("finds insertion index in a sorted array", () => {
    expect(lowerBound([], 5)).toBe(0);
    expect(lowerBound([10], 5)).toBe(0);
    expect(lowerBound([10], 15)).toBe(1);
    expect(lowerBound([1, 3, 5, 7], 4)).toBe(2);
    expect(lowerBound([1, 3, 5, 7], 5)).toBe(2);
    expect(lowerBound([1, 3, 5, 7], 8)).toBe(4);
  });
});

// Deterministic RNG so failures reproduce.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function differentialTest(side: Side): void {
  const real = new PriceLevels(side);
  const oracle = new ReferenceLevels(side);
  const rng = makeRng(20_260_805);
  for (let i = 0; i < 20_000; i++) {
    const price = 9_950 + Math.floor(rng() * 101);
    const size = rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 500);
    real.set(price, size);
    oracle.set(price, size);
    expect(real.best()).toBe(oracle.best());
    expect(real.size()).toBe(oracle.size());
  }
  real.checkInvariants();
}
