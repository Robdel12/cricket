import { scheduler } from 'node:timers/promises';

let maximumTimerDelayMs = 2_147_483_647;

function dateFor(value) {
  return value instanceof Date ? value : new Date(value);
}

async function waitUntil(until, {
  signal
} = {}) {
  let deadline = dateFor(until).getTime();

  while (deadline > Date.now()) {
    await scheduler.wait(
      Math.min(deadline - Date.now(), maximumTimerDelayMs),
      { signal }
    );
  }
}

/**
 * Normalize the worker clock used for timestamps and concrete deadline waits.
 *
 * Tests may provide both functions to advance time without sleeping. Production
 * callers normally omit the clock and use wall time.
 *
 * @param {object} [clock]
 * @returns {{ now: Function, waitUntil: Function }}
 */
export function normalizeJobClock(clock = {}) {
  if (clock.now !== undefined && typeof clock.now !== 'function')
    throw new Error('Job clock now must be a function');
  if (clock.waitUntil !== undefined && typeof clock.waitUntil !== 'function')
    throw new Error('Job clock waitUntil must be a function');

  return Object.freeze({
    now: clock.now ?? (() => new Date()),
    waitUntil: clock.waitUntil ?? waitUntil
  });
}
