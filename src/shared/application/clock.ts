export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

export const systemClock: Clock = {
  now: () => new Date(),
};
