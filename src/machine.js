import {
  StateMachine,
  eventSchema,
  initialTransition,
  isUnhandled,
  transition as transitionMachine
} from 'xstate';
import { restoreActor, snapshotSchema } from 'xstate/persist';
import { z } from 'zod';

import { validationFailed } from './errors.js';
import { frozenPlain, isJsonValue, isPlainObject } from './immutable.js';

let machineContract = Symbol.for('@robdel12/cricket.machine');
let json = z.custom(isJsonValue, { message: 'Expected a plain JSON value' });

export function isMachineContract(value) {
  return value?.[machineContract] === true;
}

function statePaths(states, prefix = '') {
  return Object.entries(states ?? {}).flatMap(([key, state]) => {
    let path = prefix + key;
    return [path, ...statePaths(state.states, path + '.')];
  });
}

function isName(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function isReservedEvent(type) {
  return typeof type === 'string' && /^@?xstate\./.test(type);
}

async function parseStandard(schema, value, errorFor) {
  let result = await schema['~standard'].validate(value);
  if (result.issues)
    throw errorFor(result);
  return result.value;
}

function assertNoPendingWork(machine, { timers = [], children = {} }) {
  if (timers.length || Object.keys(children).length)
    throw new Error(`Machine ${machine.id} requires a snapshot without timers or child actors`);
}

function assertSnapshot(machine, snapshot) {
  if (snapshot?.machine !== machine)
    throw new Error(`Expected an XState snapshot for ${machine.id}`);
  if (snapshot.status === 'error')
    throw new Error(`Machine ${machine.id} failed`, { cause: snapshot.error });
  assertNoPendingWork(machine, snapshot);
}

function resultFor(machine, [snapshot, effects]) {
  let emitted = [];
  for (let effect of effects) {
    if (effect.kind === 'emit') {
      let event = json.parse(effect.event);
      if (!isPlainObject(event) || !isName(event.type))
        throw new Error(`Machine ${machine.id} must emit an event with a non-empty type`);
      emitted.push(event);
      continue;
    }

    // XState reports the root actor's completion even when evaluating a pure transition.
    if (effect.kind === 'builtin' && effect.type === '@xstate.terminate' &&
        effect.actor === effect.source && effect.status === 'done')
      continue;

    throw new Error(`Machine ${machine.id} returned an unsupported effect ${effect.type ?? effect.kind}`);
  }
  assertSnapshot(machine, snapshot);

  return Object.freeze({ kind: 'applied', snapshot, emitted: frozenPlain(emitted) });
}

/**
 * @guide machines Model domain state
 *
 * Use a machine when a product event can do different things depending on the current state. A draft report can be submitted, and the same report can be marked published when a job succeeds.
 *
 * Put the chart in a `*.machine.js` file. Pass a native XState v6 chart to `defineMachine` and give it an ID, a version, and schemas for its public events. Your service loads a snapshot, calls `transition(snapshot, event)`, and saves the result in a transaction. Store a checkpoint with `persist` and read it back with `restore` if the chart needs more than the state you already keep in a row.
 *
 * Keep guards and transition callbacks pure. Save any work that has to survive a crash in the same transaction, then let a job deliver it. The [report publication example](../examples/report-publication.js) shows how a chart emits a request for work.
 */
/**
 * Define a domain machine backed by a native XState v6 chart.
 * Services evaluate events and decide how to persist the result and deliver emitted facts.
 * @param {import('xstate').AnyStateMachine} machine
 */
export function defineMachine(machine) {
  if (!(machine instanceof StateMachine) || !isName(machine.config.id) || !isName(machine.version))
    throw new Error('defineMachine requires a chart from createMachine exported by Cricket with an explicit id and version');

  let events = machine.schemas?.events;
  if (!isPlainObject(events) || !Object.keys(events).length ||
      Object.entries(events).some(([name, schema]) =>
        !isName(name) || typeof schema?.['~standard']?.validate !== 'function'
      ))
    throw new Error(`Machine ${machine.id} requires runtime schemas for its public events`);
  if (Object.keys(events).some(isReservedEvent))
    throw new Error(`Machine ${machine.id} cannot declare reserved XState events as public events`);

  let publicEventSchema = eventSchema(machine);
  let persistedSchema = snapshotSchema(machine);
  let invalidCheckpoint = result =>
    new Error(`Invalid checkpoint for machine ${machine.id} version ${machine.version}`, { cause: result.issues });

  async function initial(input) {
    let schema = machine.schemas.input;
    let parsed = schema ? await parseStandard(schema, input, validationFailed) : input;
    return resultFor(machine, initialTransition(machine, parsed));
  }

  async function transition(snapshot, event) {
    assertSnapshot(machine, snapshot);
    if (!isPlainObject(event) || !Object.hasOwn(event, 'type') || !isName(event.type) || isReservedEvent(event.type))
      throw validationFailed({ issues: [{ path: ['type'], message: 'Expected a product event with a non-empty type' }] });
    let parsed = await parseStandard(publicEventSchema, event, validationFailed);
    let result = transitionMachine(machine, snapshot, parsed);
    if (isUnhandled(snapshot, result))
      return Object.freeze({ kind: 'unhandled', snapshot, emitted: Object.freeze([]) });
    return resultFor(machine, result);
  }

  async function persist(snapshot) {
    assertSnapshot(machine, snapshot);
    let entries = Object.entries(machine.getPersistedSnapshot(snapshot))
      .filter(([, value]) => value !== undefined);
    let checkpoint = json.parse(Object.fromEntries(entries));
    await parseStandard(persistedSchema, checkpoint, invalidCheckpoint);
    return frozenPlain(checkpoint);
  }

  async function restore(checkpoint) {
    let data = structuredClone(json.parse(checkpoint));
    if (data?.machine?.id !== machine.id || data.machine.version !== machine.version)
      throw new Error(`Expected a checkpoint for machine ${machine.id} version ${machine.version}`);
    let parsed = await parseStandard(persistedSchema, data, invalidCheckpoint);
    assertNoPendingWork(machine, parsed);
    let snapshot = restoreActor(machine, parsed).getSnapshot();
    assertSnapshot(machine, snapshot);
    return snapshot;
  }

  return Object.freeze({
    [machineContract]: true,
    id: machine.id,
    version: machine.version,
    states: Object.freeze(statePaths(machine.config.states)),
    events: Object.freeze(Object.keys(events)),
    machine,
    initial,
    transition,
    persist,
    restore
  });
}
