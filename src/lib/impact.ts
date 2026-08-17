/**
 * Market-order impact: what it actually costs to cross the spread.
 *
 * The book's headline metrics - spread, mid, microprice, imbalance - describe
 * the touch. They say nothing about what happens when you send an order big
 * enough to eat through it. This walks the resting depth on the far side and
 * reports the volume-weighted average fill price, the slippage against the
 * mid, and whether the book even had enough size to fill you. It is the
 * aggressive-order counterpart to the passive queue models in ./queue: those
 * ask "will my resting order fill?", this asks "if I take liquidity now, what
 * price do I pay?".
 *
 * Everything is in the same integer ticks and lots as the rest of the engine,
 * so a caller formats the results through the Instrument exactly as it does
 * every other price and size.
 */

import { Side, opposite } from "./types.js";
import type { OrderBook } from "./book.js";

export interface Sweep {
  /** The side taking liquidity: Bid = a market buy, Ask = a market sell. */
  readonly aggressor: Side;
  /** Lots requested. */
  readonly requestedSize: number;
  /** Lots actually filled (less than requested iff the book was exhausted). */
  readonly filledSize: number;
  /** Volume-weighted average fill price, in ticks, or null if nothing filled. */
  readonly vwap: number | null;
  /** Adverse move from the mid to the VWAP, in ticks (always ≥ 0 for a
   *  marketable order against a normal book). Null if mid or fill is
   *  undefined. */
  readonly slippageTicks: number | null;
  /** Distinct price levels consumed. */
  readonly levelsConsumed: number;
  /** True if the requested size exceeded the visible depth on that side. */
  readonly exhausted: boolean;
}

/** Walk `size` lots of a market order through the resting book and report
 *  the fill. A buy consumes asks from the touch up; a sell consumes bids
 *  from the touch down. */
export function sweep(book: OrderBook, aggressor: Side, size: number): Sweep {
  const mid = book.mid();
  const restingSide = opposite(aggressor);
  // A large depth so we walk the whole visible side; top() clamps to what
  // is actually there.
  const levels = book.levels(restingSide, 1_000_000);

  let remaining = Math.max(0, size);
  let notional = 0; // Σ price × size, in tick·lot units.
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, level.size);
    notional += level.price * taken;
    remaining -= taken;
    levelsConsumed++;
  }

  const filledSize = Math.max(0, size) - remaining;
  const vwap = filledSize > 0 ? notional / filledSize : null;
  const slippageTicks = vwap !== null && mid !== null
    ? (aggressor === Side.Bid ? vwap - mid : mid - vwap)
    : null;

  return {
    aggressor,
    requestedSize: size,
    filledSize,
    vwap,
    slippageTicks,
    levelsConsumed,
    exhausted: remaining > 0,
  };
}

/** Slippage as a fraction of the mid (multiply by 10⁴ for basis points),
 *  or null if it can't be computed. Handy for comparing impact across
 *  instruments at different price levels. */
export function slippageFraction(book: OrderBook, aggressor: Side, size: number): number | null {
  const s = sweep(book, aggressor, size);
  const mid = book.mid();
  if (s.slippageTicks === null || mid === null || mid === 0) return null;
  return s.slippageTicks / mid;
}

export interface MoveCost {
  /** Lots that must be taken to move the touch by the requested ticks. */
  readonly lots: number;
  /** Notional consumed to do it (Σ price × size), in tick·lot units. */
  readonly notional: number;
  /** True if the visible book actually reaches the target price - i.e. there
   *  is resting size at or beyond it to become the new touch. When false the
   *  move consumes everything visible and still can't be confirmed. */
  readonly reachable: boolean;
}

/**
 * The inverse of {@link sweep}: how much you'd have to buy (or sell) to push
 * the touch `ticks` away from where it is now - a direct read on book
 * resiliency. A buy must clear every ask priced below `bestAsk + ticks`; a
 * sell must clear every bid priced above `bestBid − ticks`.
 */
export function costToMove(book: OrderBook, aggressor: Side, ticks: number): MoveCost {
  const restingSide = opposite(aggressor);
  const touch = aggressor === Side.Bid ? book.bestAsk() : book.bestBid();
  if (touch === null || ticks <= 0) {
    return { lots: 0, notional: 0, reachable: touch !== null };
  }
  const target = aggressor === Side.Bid ? touch + ticks : touch - ticks;
  const within = (price: number): boolean =>
    aggressor === Side.Bid ? price < target : price > target;

  let lots = 0;
  let notional = 0;
  let reachable = false;
  for (const level of book.levels(restingSide, 1_000_000)) {
    if (within(level.price)) {
      lots += level.size;
      notional += level.price * level.size;
    } else {
      // The first level at/beyond the target is the wall the move stops at.
      reachable = true;
      break;
    }
  }
  return { lots, notional, reachable };
}

export interface DepthPoint {
  readonly price: number;
  /** Cumulative lots available from the touch out to and including this level. */
  readonly cumulativeSize: number;
  /** Cumulative notional (Σ price × size) out to this level, in tick·lot units. */
  readonly cumulativeNotional: number;
}

/** The cumulative depth curve for one side, best-first - the data behind a
 *  depth chart, and the input a caller can bisect to answer "how many lots
 *  can I take before slipping N ticks?". */
export function depthCurve(book: OrderBook, side: Side, maxLevels = 50): DepthPoint[] {
  const levels = book.levels(side, maxLevels);
  const out: DepthPoint[] = [];
  let cumulativeSize = 0;
  let cumulativeNotional = 0;
  for (const level of levels) {
    cumulativeSize += level.size;
    cumulativeNotional += level.price * level.size;
    out.push({ price: level.price, cumulativeSize, cumulativeNotional });
  }
  return out;
}
