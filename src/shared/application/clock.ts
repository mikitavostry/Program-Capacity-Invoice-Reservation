/**
 * The current time, as a dependency rather than a global.
 *
 * Every timestamp the domain records — when a reservation was made, when a repayment
 * arrived — comes from here, so tests can pin time exactly instead of asserting "roughly now".
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

export const systemClock: Clock = {
  now: () => new Date(),
};
