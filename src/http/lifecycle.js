let lifecyclePhases = new Set([
  'starting',
  'ready',
  'shutting_down',
  'stopped'
]);

function snapshotOf(state) {
  return Object.freeze({
    ...state
  });
}

/**
 * Create Cricket's internal runtime lifecycle pair.
 *
 * Apps receive the frozen reader. Only the HTTP runtime keeps the controller,
 * so lifecycle mutation stays at the process boundary Cricket actually owns.
 */
export function createRuntimeLifecycle() {
  let state = {
    phase: 'starting'
  };

  let lifecycle = Object.freeze({
    phase() {
      return state.phase;
    },

    status() {
      return snapshotOf(state);
    },

    isReady() {
      return state.phase === 'ready';
    },

    isShuttingDown() {
      return state.phase === 'shutting_down';
    },

    isStopped() {
      return state.phase === 'stopped';
    }
  });

  function transition(phase, metadata = {}) {
    if (!lifecyclePhases.has(phase))
      throw new Error(`Unknown Cricket lifecycle phase: ${phase}`);

    state = {
      ...state,
      ...metadata,
      phase
    };
  }

  return Object.freeze({
    lifecycle,

    ready() {
      transition('ready');
    },

    shuttingDown(signal) {
      transition('shutting_down', signal ? {
        signal
      } : {});
    },

    stopped() {
      transition('stopped');
    }
  });
}
