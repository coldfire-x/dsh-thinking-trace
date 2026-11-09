import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config, traceSchema } from './index.js';
import { createTraceReducer, TRACE_KEY } from './trace.js';

const text = value => ({ type: 'text', text: value });
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [text('Check the build')] } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', model: 'example', replayState: 'PRIVATE_REPLAY' }, content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, text('I will run the existing build check.')] }, stream: [{ type: 'reasoning-chunks', texts: ['PRIVATE_STREAM'] }] } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'build-1', name: 'bash', arguments: '{"command":"npm run build","description":"Run existing build check"}' } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'build-1', source: { kind: 'tool', callId: 'build-1' }, content: [text('Build passed')], isError: false } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map((event, seq) => ({ ...event, seq, time: 1000 + seq * 100 }));

test('every lifecycle state survives Host wire validation and checkpoint restore', () => {
  const reducer = createTraceReducer(Config({}));
  const initial = reducer.init({ id: 'schema-session' }, 0);
  let state = initial;
  let checkpoint;
  for (const event of events) {
    state = reducer.apply(state, event);
    assert.deepEqual(traceSchema.parse(state), state);
    if (event.seq === 4) checkpoint = traceSchema.parse(JSON.parse(JSON.stringify(state)));
  }
  const restored = events.slice(5).reduce(reducer.apply, checkpoint);
  assert.deepEqual(restored, state);
  assert.equal(state.entries.filter(e => e.kind === 'tool').length, 1);
  assert.equal(state.entries.find(e => e.callId === 'build-1').status, 'completed');
  assert.equal(state.entries.find(e => e.callId === 'build-1').durationMs, 100);
  assert.equal(JSON.stringify(state).includes('PRIVATE_'), false);
  assert.equal(state.status, 'completed');
});

test('activation awaits registration and keeps an unload disposer', async () => {
  const cleanups = [];
  let registered;
  let ready;
  let disposalCount = 0;
  const ctx = {
    sessionProjections: { register(definition) {
      registered = definition;
      return new Promise(resolve => { ready = resolve; });
    } },
    effect(factory) { cleanups.push(factory()); },
  };
  const activation = apply(ctx, Config({}));
  assert.equal(registered.key, TRACE_KEY);
  assert.equal(registered.wire.summary, false);
  assert.equal(cleanups.length, 0);
  ready({ dispose: async () => { disposalCount++; } });
  await activation;
  assert.equal(cleanups.length, 1);
  const state = registered.init({ id: 'registration-session' }, 0);
  assert.equal(registered.wire.view(state), state);
  assert.deepEqual(registered.wire.viewSchema.parse(state), state);
  await cleanups[0]();
  assert.equal(disposalCount, 1);
});
