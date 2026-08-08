/**
 * Where your order sits in the queue, and what happens when the level
 * shrinks.
 *
 * A level-2 feed reports that size at a price fell from 500 to 300. It does
 * not say why. If 200 lots traded, they came off the front of the queue.
 * If 200 lots were cancelled, they could have been anywhere. The feed
 * cannot tell you which, and for a resting order the difference decides
 * whether it fills.
 *
 * Trades are usually published separately, which resolves the trade portion.
 * Where in the queue the *cancellations* sat is not recoverable. These
 * models frame the assumption explicitly: each names where it thinks
 * cancellations come from, and the honest way to report a fill probability
 * is as a range across all three rather than a single number from whichever
 * one flatters your intuition.
 *
 * The split is not purely a modelling choice, though. It is bounded by
 * arithmetic. If nothing is behind an order, every cancellation must be in
 * front regardless of preference. `clamp` enforces that; the models supply
 * only the preference.
 */

export interface QueueModel {
  readonly name: string;
  /** How many of `cancelled` lots were in front of the order. `ahead` and
   *  `behind` are other participants' sizes on either side. */
  cancellationsAhead(ahead: number, behind: number, cancelled: number): number;
  /**
   * The fraction of the queue *ahead* of a resting order that this model
   * assumes clears by cancellation over a holding window — as opposed to
   * only clearing when trades chew through it from the front.
   *
   * This is the parameter that makes the three models diverge for a *newly
   * placed* order. The `cancellationsAhead` arithmetic above collapses to a
   * single answer when nothing rests behind the order (always true at the
   * instant of placement — see fill.ts), because with an empty tail every
   * cancellation is forced to come from ahead. The live viewer therefore
   * brackets fill probability with an explicit, named assumption about how
   * much of the queue ahead is cancellation-driven rather than deriving it
   * from that degenerate split. Pessimistic assumes none of it; optimistic
   * assumes most; proportional sits between. It is a modelling choice, not
   * an observable, which is exactly why the honest output is a range.
   */
  readonly cancelShareAhead: number;
}

/** Force a preferred split into the range the sizes actually allow. */
export function clamp(
  ahead: number, behind: number, cancelled: number, preferred: number,
): number {
  const lowest = Math.max(0, cancelled - behind);
  const highest = Math.min(cancelled, ahead);
  if (highest < lowest) {
    throw new Error(
      `cannot cancel ${cancelled} from a queue of ${ahead} ahead and ${behind} behind`,
    );
  }
  return Math.max(lowest, Math.min(preferred, highest));
}

/** Cancellations come from behind us wherever possible. Move up only when
 *  arithmetic forces it. The default; a fill estimate wrong in this
 *  direction understates rather than overstates. */
export class PessimisticQueue implements QueueModel {
  readonly name = "pessimistic";
  /** No cancellation help: the queue ahead only clears by trading through
   *  it (pure FIFO). The lower bound on fill. */
  readonly cancelShareAhead = 0;
  cancellationsAhead(ahead: number, behind: number, cancelled: number): number {
    return clamp(ahead, behind, cancelled, 0);
  }
}

/** Cancellations come from in front of us wherever possible. */
export class OptimisticQueue implements QueueModel {
  readonly name = "optimistic";
  /** Front-loaded cancellation: most of the queue ahead is assumed to pull
   *  over the window, so the order advances with little trading. The upper
   *  bound on fill. */
  readonly cancelShareAhead = 0.8;
  cancellationsAhead(ahead: number, behind: number, cancelled: number): number {
    return clamp(ahead, behind, cancelled, cancelled);
  }
}

/** Cancellations spread uniformly across the queue. If a third of the level
 *  sits in front of us, a third of the cancels are assumed to. Closest to a
 *  queue where every participant is equally likely to pull, though real
 *  queues are not uniform: orders near the front are older and stickier,
 *  which makes this mildly optimistic in practice. */
export class ProportionalQueue implements QueueModel {
  readonly name = "proportional";
  /** A moderate share of the queue ahead cancels — between the FIFO floor
   *  and the front-loaded ceiling. */
  readonly cancelShareAhead = 0.55;
  cancellationsAhead(ahead: number, behind: number, cancelled: number): number {
    const total = ahead + behind;
    const preferred = total <= 0 ? 0 : Math.round(cancelled * ahead / total);
    return clamp(ahead, behind, cancelled, preferred);
  }
}

/** All three, worst-to-best. Sweep a fill estimate across the full range
 *  and quote the bracket rather than picking one and hoping. */
export const ALL_MODELS: readonly QueueModel[] = Object.freeze([
  new PessimisticQueue(),
  new ProportionalQueue(),
  new OptimisticQueue(),
]);

export function byName(name: string): QueueModel {
  const model = ALL_MODELS.find((m) => m.name === name);
  if (!model) {
    const available = ALL_MODELS.map((m) => m.name).join(", ");
    throw new Error(`unknown queue model '${name}'; available: ${available}`);
  }
  return model;
}
