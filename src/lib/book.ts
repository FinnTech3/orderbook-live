/**
 * The order book itself.
 *
 * Applies snapshots and deltas to two PriceLevels containers, one per side,
 * and exposes the microstructural quantities a strategy actually reads. It
 * knows nothing about which venue produced the events - that is the
 * adapter's job - and nothing about how they arrived in order, which is the
 * sequencing layer's.
 */

import { PriceLevels } from "./levels.js";
import { Side } from "./types.js";
import type {
  DepthDelta,
  Instrument,
  PriceSize,
  SequenceId,
  Snapshot,
} from "./types.js";

export class CrossedBookError extends Error {
  override readonly name = "CrossedBookError";
  constructor(bestBid: number, bestAsk: number, sequence: SequenceId) {
    super(
      `book crossed after sequence ${sequence}: best bid ${bestBid} >= best ask ${bestAsk}`,
    );
  }
}

export class OrderBook {
  readonly instrument: Instrument;
  readonly bids: PriceLevels;
  readonly asks: PriceLevels;
  private _lastSequence: SequenceId | null = null;
  private _eventTimeMs: number | null = null;

  constructor(instrument: Instrument) {
    this.instrument = instrument;
    this.bids = new PriceLevels(Side.Bid);
    this.asks = new PriceLevels(Side.Ask);
  }

  loadSnapshot(snapshot: Snapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const level of snapshot.bids) this.bids.set(level.price, level.size);
    for (const level of snapshot.asks) this.asks.set(level.price, level.size);
    this._lastSequence = snapshot.sequence;
    this._eventTimeMs = snapshot.eventTimeMs;
    this.assertUncrossed();
  }

  /**
   * Apply one incremental update. Both sides are written before the
   * crossing check runs: a single message can legitimately lift the bid
   * above the *old* ask and lower the ask out of the way in one step, and
   * checking level-by-level would raise on a book that is fine once the
   * message is fully applied.
   */
  applyDelta(delta: DepthDelta): void {
    for (const level of delta.bids) this.bids.set(level.price, level.size);
    for (const level of delta.asks) this.asks.set(level.price, level.size);
    this._lastSequence = delta.sequence;
    this._eventTimeMs = delta.eventTimeMs;
    this.assertUncrossed();
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this._lastSequence = null;
    this._eventTimeMs = null;
  }

  bestBid(): number | null { return this.bids.best(); }
  bestAsk(): number | null { return this.asks.best(); }

  /** Best ask minus best bid, in ticks. `null` if either side is empty. */
  spread(): number | null {
    const b = this.bids.best();
    const a = this.asks.best();
    return b === null || a === null ? null : a - b;
  }

  /** Midpoint in ticks. May be a half-tick. */
  mid(): number | null {
    const b = this.bids.best();
    const a = this.asks.best();
    return b === null || a === null ? null : (b + a) / 2;
  }

  /** Size-weighted midpoint. Weighted by the *opposite* side's size, so
   *  heavy bid depth pulls the estimate toward the ask. A better short-
   *  horizon predictor of where the next trade prints than the plain mid. */
  microprice(): number | null {
    const b = this.bids.best();
    const a = this.asks.best();
    if (b === null || a === null) return null;
    const bidSize = this.bids.sizeAt(b);
    const askSize = this.asks.sizeAt(a);
    const total = bidSize + askSize;
    if (total === 0) return null;
    return (a * bidSize + b * askSize) / total;
  }

  /** Order book imbalance over the top `depth` levels. In [-1, 1]:
   *  +1 is all bid, -1 is all ask. Widely used as a short-horizon
   *  directional signal on the reasoning that the heavier side is more
   *  likely to be the one that gets consumed. */
  imbalance(depth = 1): number | null {
    const bid = this.bids.top(depth).reduce((s, l) => s + l.size, 0);
    const ask = this.asks.top(depth).reduce((s, l) => s + l.size, 0);
    const total = bid + ask;
    if (total === 0) return null;
    return (bid - ask) / total;
  }

  levels(side: Side, depth: number): PriceSize[] {
    return (side === Side.Bid ? this.bids : this.asks).top(depth);
  }

  sizeAt(side: Side, price: number): number {
    return (side === Side.Bid ? this.bids : this.asks).sizeAt(price);
  }

  isCrossed(): boolean {
    const b = this.bids.best();
    const a = this.asks.best();
    return b !== null && a !== null && b >= a;
  }

  lastSequence(): SequenceId | null { return this._lastSequence; }
  eventTimeMs(): number | null { return this._eventTimeMs; }

  private assertUncrossed(): void {
    if (this.isCrossed()) {
      throw new CrossedBookError(
        this.bids.best()!,
        this.asks.best()!,
        this._lastSequence ?? -1,
      );
    }
  }

  checkInvariants(): void {
    this.bids.checkInvariants();
    this.asks.checkInvariants();
    if (this.isCrossed()) {
      throw new Error("book is crossed");
    }
  }
}
