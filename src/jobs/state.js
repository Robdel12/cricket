import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let recordKeys = new Set([
  'table',
  'id'
]);
let derivedKeys = new Set([
  'from'
]);

/**
 * Inspect-only state metadata builders for Cricket jobs.
 *
 * State metadata explains where product truth lives. Cricket does not infer or
 * mutate app-owned tables from these contracts.
 */
export let state = Object.freeze({
  /**
   * Declare that one app-owned row represents job truth.
   *
   * @param {object} options - Record state options.
   * @param {string} options.table - App-owned table name.
   * @param {string|Function} options.id - Static id or function that computes it.
   * @returns {object} Frozen state metadata.
   */
  record(options = {}) {
    assertKnownOptions(options, recordKeys, 'state.record');

    if (!options.table || typeof options.table !== 'string')
      throw new Error('state.record needs a table');

    if (typeof options.id !== 'string' && typeof options.id !== 'function')
      throw new Error('state.record id must be a string or function');

    return frozenPlain({
      mode: 'record',
      table: options.table,
      id: options.id
    });
  },

  /**
   * Declare that product truth is derived from app-owned records.
   *
   * @param {object} options - Derived state options.
   * @param {string[]} options.from - App-owned records or concepts involved.
   * @returns {object} Frozen state metadata.
   */
  derived(options = {}) {
    assertKnownOptions(options, derivedKeys, 'state.derived');

    if (!Array.isArray(options.from) || !options.from.every(item => typeof item === 'string'))
      throw new Error('state.derived needs from string array');

    return frozenPlain({
      mode: 'derived',
      from: [...options.from]
    });
  },

  /**
   * Declare that queue-retained execution state is enough for this job.
   *
   * @returns {object} Frozen state metadata.
   */
  queue() {
    return frozenPlain({
      mode: 'queue'
    });
  }
});
