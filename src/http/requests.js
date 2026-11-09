let retainedErrorLimit = 32;

function failureFor(errors, suppressed) {
  let failures = suppressed ? [
    ...errors,
    Object.assign(new Error(`${suppressed} additional request completion failures were omitted`), {
      code: 'REQUEST_FAILURES_SUPPRESSED',
      count: suppressed
    })
  ] : errors;
  return failures.length === 1 ? failures[0] : new AggregateError(failures, 'Request completion failed');
}

/**
 * Own accepted application work independently of client connections.
 * Each frozen pause hold closes admission synchronously. Its idle wait includes
 * accepted handler, response, cleanup, and observer work. Aborting that wait
 * leaves the hold closed; resume releases only this owner's hold.
 */
export function createRequestTracker() {
  let active = new Set();
  let holds = new Set();
  let waiters = new Set();
  let errors = [];
  let suppressed = 0;
  let stopped = false;

  function notify() {
    if (active.size || !waiters.size)
      return;

    let failed = errors.length > 0;
    let failure = failed ? failureFor(errors, suppressed) : undefined;
    errors = [];
    suppressed = 0;

    for (let waiter of [...waiters])
      waiter.finish(failure, failed);
  }

  function idle({ signal } = {}) {
    if (signal?.aborted)
      return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      let waiter = {
        finish(error, failed) {
          waiters.delete(waiter);
          signal?.removeEventListener('abort', abort);
          failed ? reject(error) : resolve();
        }
      };
      let abort = () => waiter.finish(signal.reason, true);
      waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      notify();
    });
  }

  let requests = Object.freeze({
    pause() {
      let hold = {};
      holds.add(hold);

      return Object.freeze({
        idle(options) {
          if (!holds.has(hold))
            return Promise.reject(new Error('Cannot wait on a resumed request hold'));

          return idle(options);
        },
        resume() {
          holds.delete(hold);
        }
      });
    }
  });

  return {
    requests,
    idle,
    stop() {
      stopped = true;
    },
    run(action) {
      if (stopped || holds.size)
        return undefined;

      let settle;
      let completion = new Promise(resolve => { settle = resolve; });
      active.add(completion);

      // Register before calling application code, including its first await.
      void Promise.resolve().then(action).catch(error => {
        if (errors.length < retainedErrorLimit)
          errors.push(error);
        else
          suppressed += 1;
      }).finally(() => {
        active.delete(completion);
        settle();
        notify();
      });

      return completion;
    }
  };
}
