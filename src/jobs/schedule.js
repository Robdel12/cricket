import { CronExpressionParser } from 'cron-parser';

import { frozenPlain } from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let cronScheduleKeys = new Set([
  'key',
  'cron',
  'timezone',
  'input',
  'enabled',
  'runOnStartup'
]);

function timestamp(value) {
  let date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function assertFunction(value, name) {
  if (value !== undefined && typeof value !== 'function')
    throw new Error(`${name} must be a function`);
}

/**
 * Describe cron-backed schedule metadata for a Cricket job.
 *
 * The returned object is a frozen contract. Cricket uses `cron-parser` behind
 * the scenes to calculate due slots, then materializes those slots as normal
 * immutable job envelopes.
 *
 * @param {object} options - Cron schedule options.
 * @param {string} options.key - Stable schedule identity.
 * @param {string} options.cron - Cron expression.
 * @param {string} [options.timezone='UTC'] - IANA timezone.
 * @param {Function} options.input - Builds job input from a schedule context.
 * @param {Function} [options.enabled] - Predicate that can disable the schedule.
 * @param {boolean} [options.runOnStartup=false] - Enqueue once when the worker starts.
 * @returns {object} Frozen schedule contract.
 */
export function cronSchedule(options = {}) {
  assertKnownOptions(options, cronScheduleKeys, 'cronSchedule');

  if (!options.key || typeof options.key !== 'string')
    throw new Error('cronSchedule needs a string key');

  if (!options.cron || typeof options.cron !== 'string')
    throw new Error('cronSchedule needs a cron expression');

  if (options.timezone !== undefined && typeof options.timezone !== 'string')
    throw new Error('cronSchedule timezone must be a string');

  assertFunction(options.enabled, 'cronSchedule enabled');

  if (typeof options.input !== 'function')
    throw new Error('cronSchedule input must be a function');

  if (options.runOnStartup !== undefined && typeof options.runOnStartup !== 'boolean')
    throw new Error('cronSchedule runOnStartup must be a boolean');

  CronExpressionParser.parse(options.cron, {
    currentDate: new Date(),
    strict: false,
    tz: options.timezone ?? 'UTC'
  });

  return frozenPlain({
    key: options.key,
    cron: options.cron,
    timezone: options.timezone ?? 'UTC',
    input: options.input,
    ...(options.enabled ? { enabled: options.enabled } : {}),
    runOnStartup: options.runOnStartup === true
  });
}

export function previousCronRun(schedule, now) {
  let interval = CronExpressionParser.parse(schedule.cron, {
    currentDate: now,
    strict: false,
    tz: schedule.timezone ?? 'UTC'
  });

  return timestamp(interval.prev().toDate());
}

/**
 * Plan due cron slots from a schedule cursor and a fixed clock.
 *
 * @param {object} schedule - Schedule contract.
 * @param {object} options
 * @param {string|Date} options.lastRunAt - Cursor for the last planned slot.
 * @param {string|Date} options.now - Clock boundary.
 * @param {number} [options.limit=10] - Maximum due slots to collect.
 * @returns {object} Frozen schedule plan.
 */
export function planCronSchedule(schedule, {
  lastRunAt,
  now,
  limit = 10
} = {}) {
  if (!lastRunAt)
    throw new Error('planCronSchedule needs lastRunAt');

  if (!now)
    throw new Error('planCronSchedule needs now');

  let nowDate = now instanceof Date ? now : new Date(now);
  let interval = CronExpressionParser.parse(schedule.cron, {
    currentDate: lastRunAt,
    strict: false,
    tz: schedule.timezone ?? 'UTC'
  });
  let due = [];
  let nextRunAt;

  while (due.length < limit) {
    let nextDate = interval.next().toDate();
    let scheduledFor = timestamp(nextDate);

    nextRunAt = scheduledFor;

    if (nextDate > nowDate)
      break;

    due.push({
      slotId: `${schedule.key}:${scheduledFor}`,
      scheduleKey: schedule.key,
      scheduledFor
    });
  }

  return frozenPlain({
    due,
    nextRunAt,
    missed: due.length === limit
  });
}
