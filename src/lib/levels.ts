/**
 * One side of the book: a Map from price ticks to size, kept ordered by a
 * sorted array of the occupied prices.
 *
 * Both structures are updated together on every write. The Map answers "what
 * size is at price P" in O(1); the array answers "what is the best price"
 * and "give me the top N levels" without a per-read sort. An earlier version
 * used a heap; it was correct but harder to reason about because reads had
 * to skip stale entries, and stepping through a book in a debugger was
 * genuinely painful. This structure is boring and that is a feature.
 *
 * Insertion is O(log n) to find the slot plus O(n) to shift the tail. Depth
 * updates cluster near the top of the book in real markets, so the shift is
 * short in the vast majority of cases and one contiguous copy the JS engine
 * can vectorise, rather than n interpreted comparisons.
 */

import { Side } from "./types.js";
import type { PriceSize } from "./types.js";

export class PriceLevels {
  readonly side: Side;
  private readonly sizes = new Map<number, number>();
  /** Occupied prices, ascending. Same for both sides — the best price is
   *  the last element on the bid side and the first on the ask. */
  private readonly prices: number[] = [];

  constructor(side: Side) {
    this.side = side;
  }

  /** Set the absolute size at a price. A size of 0 removes the level. */
  set(price: number, size: number): void {
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid size ${size} at price ${price}`);
    }
    if (!Number.isFinite(price)) {
      throw new Error(`invalid price ${price}`);
    }
    if (size === 0) {
      if (this.sizes.delete(price)) {
        removeSorted(this.prices, price);
      }
      return;
    }
    if (!this.sizes.has(price)) {
      insertSorted(this.prices, price);
    }
    this.sizes.set(price, size);
  }

  sizeAt(price: number): number {
    return this.sizes.get(price) ?? 0;
  }

  /** Best price on this side, or `null` if empty. */
  best(): number | null {
    if (this.prices.length === 0) return null;
    return this.side === Side.Bid
      ? this.prices[this.prices.length - 1]!
      : this.prices[0]!;
  }

  /** The `depth` best levels, best first. */
  top(depth: number): PriceSize[] {
    if (depth <= 0) return [];
    const n = Math.min(depth, this.prices.length);
    const out: PriceSize[] = new Array(n);
    if (this.side === Side.Bid) {
      for (let i = 0; i < n; i++) {
        const price = this.prices[this.prices.length - 1 - i]!;
        out[i] = { price, size: this.sizes.get(price)! };
      }
    } else {
      for (let i = 0; i < n; i++) {
        const price = this.prices[i]!;
        out[i] = { price, size: this.sizes.get(price)! };
      }
    }
    return out;
  }

  /** Cumulative size within `ticks` of the touch. */
  depthWithin(ticks: number): number {
    if (ticks < 0) throw new Error("ticks cannot be negative");
    const best = this.best();
    if (best === null) return 0;
    const limit = this.side === Side.Bid ? best - ticks : best + ticks;
    let total = 0;
    if (this.side === Side.Bid) {
      for (let i = this.prices.length - 1; i >= 0; i--) {
        const price = this.prices[i]!;
        if (price < limit) break;
        total += this.sizes.get(price)!;
      }
    } else {
      for (let i = 0; i < this.prices.length; i++) {
        const price = this.prices[i]!;
        if (price > limit) break;
        total += this.sizes.get(price)!;
      }
    }
    return total;
  }

  /** Size ahead of a hypothetical passive order at `price` — everything
   *  that would be filled before it.  Returns null if `price` is on the
   *  wrong side of the touch (i.e. would cross), because that is a
   *  marketable order and needs separate handling. */
  sizeAhead(price: number): number | null {
    const best = this.best();
    if (best === null) return 0;
    if (this.side === Side.Bid && price > best) return null;
    if (this.side === Side.Ask && price < best) return null;

    let total = 0;
    if (this.side === Side.Bid) {
      for (let i = this.prices.length - 1; i >= 0; i--) {
        const p = this.prices[i]!;
        if (p < price) break;
        if (p === price) {
          // Everything strictly above price is ahead; at price itself, we
          // join the back so all of it is also ahead.
          total += this.sizes.get(p)!;
        } else {
          total += this.sizes.get(p)!;
        }
      }
    } else {
      for (let i = 0; i < this.prices.length; i++) {
        const p = this.prices[i]!;
        if (p > price) break;
        total += this.sizes.get(p)!;
      }
    }
    return total;
  }

  clear(): void {
    this.sizes.clear();
    this.prices.length = 0;
  }

  size(): number {
    return this.sizes.size;
  }

  /** For tests and the differential harness. Raises if the Map and the
   *  sorted array have drifted, which is the class of bug this container
   *  makes possible in exchange for its speed. */
  checkInvariants(): void {
    if (this.sizes.size !== this.prices.length) {
      throw new Error(
        `${this.sizes.size} sizes but ${this.prices.length} prices`,
      );
    }
    const seen = new Set<number>();
    let previous = -Infinity;
    for (const price of this.prices) {
      if (price <= previous) {
        throw new Error(`prices out of order at ${price} (prev ${previous})`);
      }
      if (seen.has(price)) {
        throw new Error(`duplicate price ${price}`);
      }
      const s = this.sizes.get(price);
      if (s === undefined) {
        throw new Error(`price ${price} listed but has no size`);
      }
      if (s <= 0) {
        throw new Error(`price ${price} has non-positive size ${s}`);
      }
      seen.add(price);
      previous = price;
    }
  }

  /** Copy of the sorted price array, for tests. */
  pricesAscending(): number[] {
    return this.prices.slice();
  }
}

// ---- sorted-array helpers ------------------------------------------------

/** Binary search for the first index `i` in `arr` where `arr[i] >= value`. */
export function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(arr: number[], value: number): void {
  const i = lowerBound(arr, value);
  arr.splice(i, 0, value);
}

function removeSorted(arr: number[], value: number): void {
  const i = lowerBound(arr, value);
  if (i < arr.length && arr[i] === value) {
    arr.splice(i, 1);
  }
}
