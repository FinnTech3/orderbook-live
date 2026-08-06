/**
 * Fill probability for a hypothetical passive order in a live book.
 *
 * This is the browser version of orderbook-sim's Simulator, cut down to the
 * single question the interactive page needs to answer: "if I placed an
 * order at price P size S now, and left it there until my target time or
 * the book had traded through V lots of volume, what fraction of it
 * probably fills?"
 *
 * There is no real "answer" to that question because the future is unknown,
 * but there is a reasonable estimate for each of the three queue models
 * given the *current* state of the book, and the range between them is the
 * finding this project exists to convey. The estimates use the same
 * ahead/behind bookkeeping the Python simulator does, without needing to
 * simulate through time.
 */

import { PriceLevels } from "../levels.js";
import { Side } from "../types.js";
import type { OrderBook } from "../book.js";
import { ALL_MODELS } from "./models.js";
import type { QueueModel } from "./models.js";

/** One row of an estimate: how much of an order probably fills under one
 *  queue model, given a volume budget. */
export interface FillEstimate {
  readonly model: string;
  /** Fraction of the order that fills, in [0, 1]. */
  readonly fillFraction: number;
  /** Lots ahead of the order at placement, other participants only. */
  readonly queueAhead: number;
  /** Lots that would need to trade at the order's price for the order to
   *  fill fully under this model. Useful to display alongside as
   *  "you would need X lots of volume at your price to fill". */
  readonly lotsNeededForFullFill: number;
}

export interface FillEstimateInput {
  readonly side: Side;
  /** Price in ticks. */
  readonly price: number;
  /** Size in lots. */
  readonly size: number;
  /** How many lots of volume you expect to trade *at your price or better*
   *  before you would cancel. If you are willing to sit forever, this is
   *  a large number; if you plan to pull after N seconds, use recent
   *  volume at price. */
  readonly volumeBudget: number;
}

export interface FillRange {
  readonly low: number;
  readonly high: number;
  readonly midpoint: number;
  readonly perModel: readonly FillEstimate[];
  readonly marketable: boolean;
}

/**
 * Estimate fill fractions under every model for a hypothetical order at the
 * *current* book state.
 *
 * If the order price is at or across the touch it is *marketable*: it would
 * fill against resting size on the other side. In that case the queue
 * models are not the interesting question — the order goes off immediately
 * up to the available depth — and we report a straightforward fraction.
 * The queue models only matter for passive placement (price on the same
 * side as the touch, resting behind whatever is already there).
 */
export function estimateFill(
  book: OrderBook,
  input: FillEstimateInput,
): FillRange {
  const { side, price, size, volumeBudget } = input;

  const marketable = isMarketable(book, side, price);
  if (marketable) {
    const opposing = side === Side.Bid ? book.bestAsk() : book.bestBid();
    if (opposing === null) {
      return degenerate(size);
    }
    const available = side === Side.Bid
      ? book.asks.sizeAt(opposing)
      : book.bids.sizeAt(opposing);
    const filled = Math.min(size, available);
    const fraction = size === 0 ? 0 : filled / size;
    const uniform: FillEstimate[] = ALL_MODELS.map((m) => ({
      model: m.name,
      fillFraction: fraction,
      queueAhead: 0,
      lotsNeededForFullFill: 0,
    }));
    return {
      low: fraction,
      high: fraction,
      midpoint: fraction,
      perModel: uniform,
      marketable: true,
    };
  }

  const sameSide: PriceLevels = side === Side.Bid ? book.bids : book.asks;

  // Everything currently shown at our price is other participants and
  // therefore ahead of us. Nothing is behind us yet, because our order is
  // hypothetical. The models still return different answers because a
  // real placement immediately begins to accumulate size behind, and the
  // question is what fraction fills before your budget is spent — see
  // the perModel breakdown below.
  const queueAtPrice = sameSide.sizeAt(price);
  const queueBetter = sizeStrictlyBetterThan(sameSide, side, price);
  const queueAhead = queueAtPrice + queueBetter;

  const perModel: FillEstimate[] = ALL_MODELS.map((model) => {
    const estimate = estimateForModel({
      model,
      queueAhead,
      orderSize: size,
      volumeBudget,
    });
    return { model: model.name, ...estimate, queueAhead };
  });

  const fractions = perModel.map((e) => e.fillFraction);
  const low = Math.min(...fractions);
  const high = Math.max(...fractions);
  const midpoint = (low + high) / 2;
  return { low, high, midpoint, perModel, marketable: false };
}

/**
 * For a single model, project a fill fraction by assuming volumeBudget
 * arrives as cancellations distributed by that model's rule, and count
 * how much of the order slot the arithmetic clears.
 *
 * The bookkeeping mirrors the simulator: `ahead` shrinks by whatever the
 * model says came from in front; when it reaches zero, the order starts
 * filling from the remaining budget. This is a stateless approximation of
 * what the Python engine does step-by-step, and it is exact under the
 * assumption that no new size joins in front of the order (which is a
 * fine approximation over short holding windows and the honest one to
 * name for longer ones — see the README limitation).
 */
function estimateForModel(args: {
  model: QueueModel;
  queueAhead: number;
  orderSize: number;
  volumeBudget: number;
}): { fillFraction: number; lotsNeededForFullFill: number } {
  const { model, queueAhead, orderSize, volumeBudget } = args;
  if (orderSize <= 0) {
    return { fillFraction: 0, lotsNeededForFullFill: 0 };
  }
  if (volumeBudget <= 0) {
    return { fillFraction: 0, lotsNeededForFullFill: queueAhead + orderSize };
  }

  // Two-stage arithmetic:
  //   1) A model-dependent fraction of the budget clears the queue ahead.
  //   2) The remainder eats into the order.
  //
  // When queueAhead is zero the model does not apply — everything reaches
  // the order directly.
  let ahead = queueAhead;
  let behind = 0;
  let budget = volumeBudget;

  // We treat the budget as cancellations first, distributed by the model,
  // then any leftover as trades. This slightly favours passive fills
  // because trades hit the front hardest; the pessimistic model still
  // reports the smallest fraction, which is the useful ordering.
  if (ahead > 0) {
    const cancelPortion = Math.min(budget, ahead + behind);
    const takenFromAhead = model.cancellationsAhead(ahead, behind, cancelPortion);
    ahead -= takenFromAhead;
    budget -= cancelPortion;
  }

  // Anything left is volume that reaches the order.
  const consumed = Math.min(orderSize, Math.max(0, budget));
  const fraction = Math.max(0, Math.min(1, consumed / orderSize));
  const lotsNeededForFullFill = queueAhead + orderSize;
  return { fillFraction: fraction, lotsNeededForFullFill };
}

function isMarketable(book: OrderBook, side: Side, price: number): boolean {
  const opposing = side === Side.Bid ? book.bestAsk() : book.bestBid();
  if (opposing === null) return false;
  return side === Side.Bid ? price >= opposing : price <= opposing;
}

function sizeStrictlyBetterThan(
  levels: PriceLevels, side: Side, price: number,
): number {
  // "Better" means closer to the touch — higher prices on the bid side,
  // lower on the ask. Anything strictly better than our price would fill
  // before us at our price, so it counts as being ahead.
  let total = 0;
  for (const level of levels.top(10_000)) {
    if (side === Side.Bid ? level.price > price : level.price < price) {
      total += level.size;
    }
  }
  return total;
}

function degenerate(size: number): FillRange {
  const zero: FillEstimate[] = ALL_MODELS.map((m) => ({
    model: m.name,
    fillFraction: 0,
    queueAhead: 0,
    lotsNeededForFullFill: size,
  }));
  return { low: 0, high: 0, midpoint: 0, perModel: zero, marketable: false };
}
