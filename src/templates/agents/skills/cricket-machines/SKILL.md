---
name: cricket-machines
description: Design or change Cricket domain machines. Use for product events, state transitions, checkpoint changes, and decisions shared by HTTP and jobs.
---

# Cricket Machines

Use a machine when the current state changes what a product event can do.
Scaffold a domain machine with `pnpm exec cricket new domain reports api/domains --with machine,service`.

- Import `createMachine` and `defineMachine` from `@robdel12/cricket`. Wrap a
  native XState v6 chart with `defineMachine`. Set `id`, `version`, and
  `schemas.events` in the chart config. Key event schemas by event type.
- Keep guards, initializers, and transition callbacks pure. Return a target,
  a shallow `{ context: ... }` patch, or both. Use `undefined` for an unhandled event
  and `{}` for a handled event with no changes. Use `enqueue.emit(...)`
  to return plain JSON facts. Use jobs for timers or external work.
- Have HTTP and workers call the same service. Inside a transaction, read
  current state under a lock or use a conditional write. When rows hold the
  full state, use `contract.machine.resolveState({ value, context })` with
  explicit context. When the chart owns initialization, use
  `(await contract.initial(input)).snapshot`.
- Call `await contract.transition(snapshot, event)`. Invalid events throw
  `VALIDATION_FAILED`. A valid event can return `kind: 'unhandled'`. Decide
  whether that means conflict, duplicate, or stale work for the feature.
  Shared schemas must accept inputs already parsed by a route or job.
- Save accepted state and any work that must survive a crash together.
  Deliver the saved work through a job. Check the current owner or attempt
  before letting a late result change product state.
- For a stored checkpoint, use `persist(snapshot)` and `restore(checkpoint)`.
  When the chart version changes, use
  `machineVersions([old.machine, next.machine]).migrateSnapshot(...)`. Test it
  with a checkpoint from the old version.

Use `pnpm exec cricket inspect api/index.js` to see loaded charts, and
[cricket-testing](../cricket-testing/SKILL.md) to test the chart and its callers.
