/**
 * Shared value types.
 *
 * Everything downstream of the venue adapter works in integer ticks and lots.
 * The conversion happens here, once, and never again. This is the same
 * discipline as orderbook-sim's Python core, ported deliberately.
 *
 * The reason is not efficiency. It is that price levels are Map keys and get
 * compared for equality on every update. In IEEE-754, 0.1 + 0.2 !== 0.3, and
 * a book built on floats eventually acquires two "identical" levels that
 * neither merge nor compare equal. Integers make that class of bug impossible
 * rather than merely rare.
 */

export const enum Side {
  Bid = "bid",
  Ask = "ask",
}

export const opposite = (side: Side): Side =>
  side === Side.Bid ? Side.Ask : Side.Bid;

/** A price level, in ticks and lots. */
export interface PriceSize {
  readonly price: number;
  readonly size: number;
}

/**
 * A monotone sequence number that orders events within a single feed. Every
 * venue publishes something like this; the specific field varies (Binance's
 * `u`, Coinbase's `sequence`), and the sequencing layer treats it as opaque.
 */
export type SequenceId = number;

/** How a price maps onto its integer grid. Immutable once created. */
export class Instrument {
  readonly symbol: string;
  /** Tick size and lot size are stored as scaled integers to avoid float
   *  drift during conversion. `priceScale` is the number of decimal places. */
  readonly priceScale: number;
  readonly sizeScale: number;
  private readonly priceUnit: number;
  private readonly sizeUnit: number;

  constructor(symbol: string, tickSize: string, lotSize: string) {
    this.symbol = symbol;
    this.priceScale = decimalsOf(tickSize);
    this.sizeScale = decimalsOf(lotSize);
    this.priceUnit = Math.round(Number(tickSize) * 10 ** this.priceScale);
    this.sizeUnit = Math.round(Number(lotSize) * 10 ** this.sizeScale);
    if (this.priceUnit <= 0) {
      throw new Error(`tick size must be positive, got ${tickSize}`);
    }
    if (this.sizeUnit <= 0) {
      throw new Error(`lot size must be positive, got ${lotSize}`);
    }
  }

  /**
   * Snap a price string onto the tick grid. A value that is not a whole
   * multiple of the tick size raises rather than rounds, because it usually
   * means the instrument is configured wrongly and silently rounding hides
   * that.
   */
  toTicks(price: string | number): number {
    const { integer, scale } = scaledInteger(price);
    // Rescale both integer and unit up to a common (finer) scale so the
    // arithmetic stays in integers. An input with more decimals than the
    // grid may still be a whole multiple of the tick, so we only reject
    // if the modulo says otherwise.
    const { intAt, unitAt } = commonScale(integer, scale, this.priceUnit, this.priceScale);
    if (intAt % unitAt !== 0) {
      throw new OffGridError(
        `price ${price} is not a multiple of tick ${this.formatPrice(1)}`,
      );
    }
    return intAt / unitAt;
  }

  toLots(size: string | number): number {
    const { integer, scale } = scaledInteger(size);
    const { intAt, unitAt } = commonScale(integer, scale, this.sizeUnit, this.sizeScale);
    if (intAt % unitAt !== 0) {
      throw new OffGridError(
        `size ${size} is not a multiple of lot ${this.formatSize(1)}`,
      );
    }
    return intAt / unitAt;
  }

  /** Best-effort snap for venue data that may not be perfectly aligned.
   *
   *  Some venues report incremental removals at prices that were originally
   *  on-grid but drift from string-to-float conversion elsewhere. Round to
   *  the nearest tick and record it rather than reject the whole update.
   *  Uses round-half-away-from-zero, matching `Math.round`. */
  snapTicks(price: string | number): number {
    const { integer, scale } = scaledInteger(price);
    const { intAt, unitAt } = commonScale(integer, scale, this.priceUnit, this.priceScale);
    return divideRoundHalfUp(intAt, unitAt);
  }

  snapLots(size: string | number): number {
    const { integer, scale } = scaledInteger(size);
    const { intAt, unitAt } = commonScale(integer, scale, this.sizeUnit, this.sizeScale);
    return Math.max(0, divideRoundHalfUp(intAt, unitAt));
  }

  fromTicks(ticks: number): number {
    return (ticks * this.priceUnit) / 10 ** this.priceScale;
  }

  fromLots(lots: number): number {
    return (lots * this.sizeUnit) / 10 ** this.sizeScale;
  }

  formatPrice(ticks: number): string {
    return this.fromTicks(ticks).toFixed(this.priceScale);
  }

  formatSize(lots: number): string {
    return this.fromLots(lots).toFixed(this.sizeScale);
  }
}

export class OffGridError extends Error {
  override readonly name = "OffGridError";
}

/** One incremental update from a venue, already in tick and lot integers. */
export interface DepthDelta {
  readonly sequence: SequenceId;
  /** The sequence this update follows, when the venue supplies it. `null`
   *  means the sequencing layer must infer continuity from adjacency. */
  readonly previousSequence: SequenceId | null;
  readonly eventTimeMs: number;
  readonly bids: readonly PriceSize[];
  readonly asks: readonly PriceSize[];
}

/** A full picture of one side of the book at a point in time. */
export interface Snapshot {
  readonly sequence: SequenceId;
  readonly eventTimeMs: number;
  readonly bids: readonly PriceSize[];
  readonly asks: readonly PriceSize[];
}

/** A single execution reported by the venue. */
export interface Trade {
  readonly price: number;
  readonly size: number;
  /** The side that crossed the spread. */
  readonly aggressor: Side;
  readonly eventTimeMs: number;
}

// ---- internals ----------------------------------------------------------

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

function decimalsOf(value: string): number {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`expected a decimal string, got ${value}`);
  }
  const dot = value.indexOf(".");
  return dot < 0 ? 0 : value.length - dot - 1;
}

/**
 * Parse a decimal string into `(integer, scale)` such that the original
 * value equals `integer / 10^scale` exactly. Preserves all input
 * precision, so a caller can detect off-grid values.
 *
 * Doing the multiplication in string space avoids IEEE drift for the
 * common case where the venue itself sends strings. Numeric inputs go
 * through `String()`, which is lossy but no worse than the original
 * observation.
 */
function scaledInteger(value: string | number): { integer: number; scale: number } {
  const text = typeof value === "string" ? value : String(value);
  if (!DECIMAL_PATTERN.test(text)) {
    throw new Error(`expected a decimal, got ${text}`);
  }
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const frac = dot < 0 ? "" : text.slice(dot + 1);
  const integer = Number(whole + frac);
  const scale = frac.length;
  if (!Number.isFinite(integer)) {
    throw new Error(`value out of safe range: ${text}`);
  }
  return { integer, scale };
}

/**
 * Rescale `integer @ scale` and `unit @ unitScale` to a shared, finer scale
 * so both are exact integers. Returns them in that common frame.
 *
 * The caller then does an integer modulo/divide, which is what makes the
 * off-grid check well-defined regardless of which side had more decimals.
 */
function commonScale(
  integer: number, scale: number, unit: number, unitScale: number,
): { intAt: number; unitAt: number } {
  if (scale >= unitScale) {
    return { intAt: integer, unitAt: unit * 10 ** (scale - unitScale) };
  }
  return { intAt: integer * 10 ** (unitScale - scale), unitAt: unit };
}

/** `a / b` rounded to the nearest integer, ties away from zero. Matches
 *  `Math.round(a / b)` but avoids the intermediate float. */
function divideRoundHalfUp(a: number, b: number): number {
  if (b <= 0) throw new Error(`non-positive divisor ${b}`);
  const sign = a < 0 ? -1 : 1;
  const abs = Math.abs(a);
  return sign * Math.floor((abs + b / 2) / b);
}
