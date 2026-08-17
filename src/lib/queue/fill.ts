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
 * models are not the interesting question - the order goes off immediately
 * up to the available depth - and we report a straightforward fraction.
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
  // question is what fraction fills before your budget is spent - see
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
 * For a single model, project the fill fraction of a newly placed order.
 *
 * The order rests at the back of the queue at its price: `queueAhead` lots
 * sit in front of it, nothing behind it yet. Two things clear the lots
 * ahead over the holding window - trades, which chew through from the
 * front, and cancellations, which can vanish from anywhere. We only observe
 * the net drainage (`volumeBudget`), not the split, so each model names an
 * assumption for how much of the queue ahead is cancellation-driven:
 * `model.cancelShareAhead`. Pessimistic assumes none of it (pure FIFO -
 * you must trade through the whole queue), optimistic assumes most of it
 * cancels out from in front of you, proportional sits between.
 *
 * The cancellation share is scaled by how much the level actually turns
 * over relative to its depth (`utilisation`): a quiet level cannot realise
 * its assumed cancellations, so all three models converge there; a busy
 * level lets them diverge, which is where the bracket widens and the honest
 * uncertainty shows.
 *
 *   effectiveAhead = queueAhead · (1 − cancelShareAhead · utilisation)
 *   reaches order  = max(0, volumeBudget − effectiveAhead)
 *   fill           = min(1, reaches order / orderSize)
 *
 * This is a stateless estimate on the current book: it assumes no new size
 * joins in front of the order, a fine approximation over short holding
 * windows and the honest thing to name for longer ones (see the README).
 */
function estimateForModel(args: {
  model: QueueModel;
  queueAhead: number;
  orderSize: number;
  volumeBudget: number;
}): { fillFraction: number; lotsNeededForFullFill: number } {
  const { model, queueAhead, orderSize, volumeBudget } = args;
  const lotsNeededForFullFill = queueAhead + orderSize;
  if (orderSize <= 0) {
    return { fillFraction: 0, lotsNeededForFullFill: 0 };
  }
  if (volumeBudget <= 0) {
    return { fillFraction: 0, lotsNeededForFullFill };
  }

  // How much the level turns over relative to what has to clear for a full
  // fill. Bounded to [0, 1] so a modest budget cannot over-credit assumed
  // cancellations. When there is no queue ahead, utilisation is irrelevant
  // - everything in the budget reaches the order directly.
  const utilisation = lotsNeededForFullFill > 0
    ? Math.min(1, volumeBudget / lotsNeededForFullFill)
    : 1;
  const effectiveAhead = queueAhead * (1 - model.cancelShareAhead * utilisation);
  const reachesOrder = Math.max(0, volumeBudget - effectiveAhead);
  const fraction = Math.max(0, Math.min(1, reachesOrder / orderSize));
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
  // "Better" means closer to the touch - higher prices on the bid side,
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
