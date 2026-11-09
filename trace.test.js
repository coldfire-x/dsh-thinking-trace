import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACE_KEY, createTraceReducer } from './trace.js';

const HEADER = { id: 'session-public', createdAt: 100, cwd: 'PRIVATE_HEADER_WORKSPACE', agentPreset: 'PRIVATE_HEADER_PRESET' };
const STATE_KEYS = [
  'sessionId', 'turn', 'step', 'status', 'model', 'entries', 'dropped',
  'totalTools', 'totalUpdates', 'totalErrors', 'limits',
].sort();
const ENTRY_KEYS = [
  'id', 'seq', 'time', 'turn', 'step', 'kind', 'title', 'text', 'callId',
  'name', 'input', 'output', 'status', 'durationMs', 'truncated', 'resultSeq',
].sort();
const text = value => ({ type: 'text', text: value });
const event = (type, seq, data, time = seq * 10) => ({ type, seq, time, data });
const prompt = (seq, value, source = { kind: 'user' }) => event('user/message', seq, {
  role: 'user', source, content: [text(value)],
});
const update = (seq, value, turn = 1, step = 1) => event('assistant/message', seq, {
  turn, step,
  message: { role: 'assistant', source: { kind: 'model', model: 'public-model' }, content: [text(value)] },
});
const call = (seq, callId, name = 'read', args = '{}', time = seq * 10, turn = 1, step = 1) => event('tool/call', seq, {
  turn, step, callId, name, arguments: args,
}, time);
const result = (seq, callId, value, extra = {}, time = seq * 10, turn = 1, step = 1) => event('tool/result', seq, {
  turn, step,
  message: {
    role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [text(value)], ...extra.message,
  },
  ...extra.data,
}, time);
const end = (seq, kind, turn = 1, extra = {}, time = seq * 10) => event('turn/end', seq, {
  turn, reason: { kind, ...extra },
}, time);
const run = (reducer, events, state = reducer.init(HEADER, 0)) => events.reduce(reducer.apply, state);
const json = value => JSON.parse(JSON.stringify(value));

function assertPlainState(state) {
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS);
  assert.deepEqual(Object.keys(state.limits).sort(), ['maxDetailChars', 'maxEntries']);
  assert.deepEqual(json(state), state);
  assert.equal(Object.getPrototypeOf(state), Object.prototype);
  for (const row of state.entries) {
    assert.deepEqual(Object.keys(row).sort(), ENTRY_KEYS);
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.seq, 'number');
    assert.equal(typeof row.time, 'number');
    assert.equal(typeof row.turn, 'number');
    assert.equal(typeof row.step, 'number');
    assert.ok(['task', 'update', 'tool', 'outcome'].includes(row.kind));
    for (const key of ['title', 'text', 'callId', 'name', 'input', 'output', 'status']) {
      assert.equal(typeof row[key], 'string', key);
    }
    assert.equal(typeof row.truncated, 'boolean');
    assert.ok(row.durationMs === null || (Number.isFinite(row.durationMs) && row.durationMs >= 0));
    assert.ok(row.resultSeq === null || Number.isSafeInteger(row.resultSeq));
  }
}

test('exports the reducer key and initializes exactly the public JSON state', () => {
  assert.equal(TRACE_KEY, 'decisionTrace');
  const reducer = createTraceReducer();
  const state = reducer.init(HEADER, 42);
  assert.deepEqual(state, {
    sessionId: 'session-public', turn: 0, step: 0, status: 'idle', model: '',
    entries: [], dropped: 0, totalTools: 0, totalUpdates: 0, totalErrors: 0,
    limits: { maxEntries: 800, maxDetailChars: 12000 },
  });
  assertPlainState(state);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.entries));
  assert.ok(Object.isFrozen(state.limits));
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_HEADER/);
});

test('only direct user text becomes a task; machinery and other block types stay private', () => {
  const reducer = createTraceReducer();
  let state = reducer.init(HEADER);
  for (const source of [undefined, { kind: 'goal' }, { kind: 'system-prompt' }, { kind: 'skill' }, { kind: 'relay' }]) {
    const machinery = event('user/message', 0, { role: 'user', source, content: [text('PRIVATE_MACHINERY')] });
    assert.strictEqual(reducer.apply(state, machinery), state);
  }
  state = reducer.apply(state, event('user/message', 1, {
    role: 'user', source: { kind: 'user', privateMetadata: 'PRIVATE_SOURCE' },
    content: [
      text('Please inspect the public activity.'),
      { type: 'reasoning', text: 'PRIVATE_REASONING' },
      { type: 'image', attachment: { data: 'PRIVATE_IMAGE' } },
      { type: 'file', attachment: { path: 'PRIVATE_FILE' } },
      { text: 'PRIVATE_UNTYPED_TEXT' },
      text('Keep the result concise.'),
    ],
    privateMetadata: 'PRIVATE_MESSAGE',
  }));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].kind, 'task');
  assert.equal(state.entries[0].text, 'Please inspect the public activity.\nKeep the result concise.');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
  assertPlainState(state);
});

test('assistant updates copy only public text and the model name, never reasoning, stream, or replay data', () => {
  const reducer = createTraceReducer();
  const state = reducer.apply(reducer.init(HEADER), event('assistant/message', 4, {
    turn: 2, step: 3,
    message: {
      role: 'assistant',
      source: { kind: 'model', model: 'visible-model', provider: 'PRIVATE_PROVIDER', replayState: { text: 'PRIVATE_REPLAY' } },
      content: [
        { type: 'reasoning', text: 'PRIVATE_THOUGHT' },
        text('I am checking the published interface.'),
        { type: 'text', channel: 'analysis', text: 'PRIVATE_ANALYSIS_BLOCK' },
        { type: 'text', channel: 'reasoning', text: 'PRIVATE_REASONING_CHANNEL' },
        { type: 'tool-call', id: 'private-call', name: 'private-tool', arguments: 'PRIVATE_ARGS' },
        { type: 'unknown', text: 'PRIVATE_UNKNOWN' },
        text('The public update is ready.'),
      ],
      metadata: 'PRIVATE_ASSISTANT_METADATA',
    },
    stream: [{ type: 'text-delta', text: 'PRIVATE_STREAM' }],
    usage: { privateMetadata: 'PRIVATE_USAGE' },
    replayState: 'PRIVATE_DATA_REPLAY',
  }));
  assert.equal(state.model, 'visible-model');
  assert.equal(state.turn, 2);
  assert.equal(state.step, 3);
  assert.equal(state.totalUpdates, 1);
  assert.equal(state.entries[0].text, 'I am checking the published interface.\nThe public update is ready.');
  assert.equal(state.entries[0].kind, 'update');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|private-call|private-tool/);
  assertPlainState(state);
});

test('analysis channels at every message boundary and non-text assistant content are ignored by reference', () => {
  const reducer = createTraceReducer();
  const state = reducer.init(HEADER);
  const base = update(1, 'PRIVATE_ANALYSIS');
  const cases = [
    { ...base, channel: 'analysis' },
    { ...base, data: { ...base.data, channel: 'analysis' } },
    { ...base, data: { ...base.data, message: { ...base.data.message, channel: 'analysis' } } },
    { ...base, data: { ...base.data, message: { ...base.data.message, content: [{ ...text('PRIVATE_BLOCK'), channel: 'analysis' }] } } },
    { ...base, data: { ...base.data, message: { ...base.data.message, content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }] } } },
    { ...base, data: { ...base.data, message: { ...base.data.message, content: 'PRIVATE_STRING_CONTENT' } } },
    { ...base, data: { ...base.data, message: { ...base.data.message, role: 'developer' } } },
    { ...base, data: { ...base.data, message: { ...base.data.message, source: { kind: 'system-prompt' } } } },
  ];
  for (const item of cases) assert.strictEqual(reducer.apply(state, item), state);
  assert.equal(state.model, '');
  assert.equal(state.totalUpdates, 0);
});

test('concurrent calls correlate by call ID in reverse completion order without mutation or mutable aliases', () => {
  const reducer = createTraceReducer();
  const argsA = '{"description":"Read the public schema","path":"schema.js"}';
  const original = run(reducer, [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    call(2, 'a', 'read', argsA, 100),
    call(3, 'b', 'list', '{"path":"."}', 120),
  ]);
  const checkpoint = json(original);
  const before = json(checkpoint);
  const b = reducer.apply(checkpoint, result(4, 'b', 'public listing', {}, 180));
  assert.deepEqual(checkpoint, before);
  assert.deepEqual(original, before);
  assert.equal(b.entries[0].status, 'running');
  assert.equal(b.entries[1].status, 'completed');
  assert.equal(b.entries[1].output, 'public listing');
  assert.equal(b.entries[1].durationMs, 60);
  assert.equal(b.entries[1].resultSeq, 4);
  assert.notStrictEqual(b.entries, checkpoint.entries);
  assert.notStrictEqual(b.entries[0], checkpoint.entries[0]);
  assert.notStrictEqual(b.limits, checkpoint.limits);
  checkpoint.entries[0].input = 'mutated checkpoint';
  checkpoint.limits.maxDetailChars = 1;
  assert.equal(b.entries[0].input, argsA);
  assert.equal(b.limits.maxDetailChars, 12000);
  const a = reducer.apply(b, result(5, 'a', 'public schema', {}, 90));
  assert.equal(a.entries.length, 2);
  assert.equal(a.totalTools, 2);
  assert.equal(a.entries[0].id, 'tool:2');
  assert.equal(a.entries[0].seq, 2);
  assert.equal(a.entries[0].resultSeq, 5);
  assert.equal(a.entries[0].title, 'Read the public schema');
  assert.equal(a.entries[0].input, argsA);
  assert.equal(a.entries[0].output, 'public schema');
  assert.equal(a.entries[0].durationMs, 0);
  assert.equal(a.entries[1].title, 'list');
  assert.equal(b.entries[0].status, 'running');
  assert.throws(() => { a.entries[0].output = 'mutate'; }, TypeError);
  assertPlainState(a);
});

test('tool title uses only a string description and input preserves raw argument JSON', () => {
  const reducer = createTraceReducer();
  const variants = [
    ['{broken JSON', 'read'],
    ['{"description":4,"decision":"PRIVATE_INFERENCE"}', 'read'],
    ['null', 'read'],
    ['"a string"', 'read'],
    ['{"description":""}', ''],
    [' { "description": "Read exact text", "x": 1 } ', 'Read exact text'],
  ];
  for (const [args, title] of variants) {
    const state = reducer.apply(reducer.init(HEADER), call(1, 'c', 'read', args));
    assert.equal(state.entries[0].title, title);
    assert.equal(state.entries[0].input, args);
    assert.equal(state.entries[0].text, '');
  }
});

test('failed results retain public text and explicit error identity while excluding private result metadata', () => {
  const reducer = createTraceReducer();
  const initial = reducer.apply(reducer.init(HEADER), call(0, 'failed', 'read', '{}', 100));
  const failure = result(1, 'failed', 'unused', {
    message: {
      isError: true,
      content: [
        text('Could not read the requested public file.'),
        { type: 'reasoning', text: 'PRIVATE_REASONING' },
        { type: 'text', channel: 'analysis', text: 'PRIVATE_ANALYSIS' },
        { type: 'image', attachment: { data: 'PRIVATE_IMAGE' } },
        text('Try an existing file.'),
      ],
      privateMetadata: 'PRIVATE_MESSAGE_META',
    },
    data: {
      error: { name: 'FileError', code: 'ENOENT', reason: 'The public file does not exist.', stack: 'PRIVATE_STACK' },
      meta: { diff: 'PRIVATE_TOOL_META' },
    },
  }, 150);
  const state = reducer.apply(initial, failure);
  assert.equal(state.entries[0].status, 'error');
  assert.equal(state.entries[0].output, 'Could not read the requested public file.\nTry an existing file.');
  assert.equal(state.entries[0].text, 'FileError / ENOENT: The public file does not exist.');
  assert.equal(state.entries[0].durationMs, 50);
  assert.equal(state.totalErrors, 1);
  assert.equal(state.totalTools, 1);
  assert.equal(initial.entries[0].status, 'running');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
  assertPlainState(state);
});

test('a result with no retained call creates a standalone tool row and preserves empty-output errors', () => {
  const reducer = createTraceReducer();
  const state = reducer.apply(reducer.init(HEADER), result(4, 'missing', '', {
    message: { isError: true, content: [] },
    data: { error: { name: 'ToolFailure', code: 'FAILED', reason: 'Public failure reason' } },
  }));
  assert.equal(state.entries.length, 1);
  const row = state.entries[0];
  assert.equal(row.kind, 'tool');
  assert.equal(row.callId, 'missing');
  assert.equal(row.name, '');
  assert.equal(row.input, '');
  assert.equal(row.output, '');
  assert.equal(row.status, 'error');
  assert.equal(row.durationMs, null);
  assert.equal(row.resultSeq, 4);
  assert.match(row.text, /Public failure reason/);
  assert.equal(state.totalErrors, 1);
  assert.equal(state.totalTools, 0);
  assertPlainState(state);
});

test('tool result source.callId is a fallback and an explicit error cannot become success', () => {
  const reducer = createTraceReducer();
  const initial = reducer.apply(reducer.init(HEADER), call(0, 'fallback'));
  const state = reducer.apply(initial, result(1, 'fallback', 'failure output', {
    message: { toolCallId: undefined, isError: false },
    data: { error: { name: 'Failure', code: 'FAILED', reason: 'A public error occurred.' } },
  }));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].callId, 'fallback');
  assert.equal(state.entries[0].status, 'error');
  assert.equal(state.totalErrors, 1);
});

test('turn-end reasons map faithfully and pending tools never acquire false successful results', () => {
  const reducer = createTraceReducer();
  const endings = [
    ['completed', 'completed'], ['error', 'error'], ['aborted', 'stopped'],
    ['blocked', 'blocked'], ['max-tokens', 'max-tokens'],
    ['interrupted', 'interrupted'], ['forked', 'forked'], ['future-kind', 'interrupted'],
  ];
  for (const [reason, status] of endings) {
    const active = run(reducer, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 2 }),
      call(2, 'pending', 'read', '{}', 100, 1, 2),
      call(3, 'done', 'list', '{}', 110, 1, 2),
      result(4, 'done', 'already completed', {}, 140, 1, 2),
    ]);
    const state = reducer.apply(active, end(5, reason, 1, {
      error: { message: 'PRIVATE_TURN_ERROR', code: 'PRIVATE_CODE' },
      reason: { kind: 'hook', reason: 'PRIVATE_HOOK_REASON' },
    }, 160));
    assert.equal(state.status, status, reason);
    assert.equal(state.entries[0].status, reason === 'aborted' ? 'stopped' : 'interrupted', reason);
    assert.equal(state.entries[0].durationMs, 60);
    assert.equal(state.entries[0].resultSeq, null);
    assert.equal(state.entries[0].output, '');
    assert.equal(state.entries[1].status, 'completed');
    assert.equal(state.entries[1].resultSeq, 4);
    assert.equal(state.entries[2].kind, 'outcome');
    assert.equal(state.entries[2].status, status);
    assert.equal(state.entries[2].step, 2);
    assert.equal(state.totalErrors, reason === 'error' ? 1 : 0);
    assert.equal(active.entries[0].status, 'running');
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
    assertPlainState(state);
  }
});

test('ending one turn closes only that turn and starting the next resets the step', () => {
  const reducer = createTraceReducer();
  const active = run(reducer, [call(0, 'other', 'read', '{}', 10, 1, 1), call(1, 'current', 'read', '{}', 20, 2, 3)]);
  const ended = reducer.apply(active, end(2, 'aborted', 2, {}, 5));
  assert.equal(ended.entries[0].status, 'running');
  assert.equal(ended.entries[1].status, 'stopped');
  assert.equal(ended.entries[1].durationMs, 0);
  const next = reducer.apply(ended, event('turn/start', 3, { turn: 3 }));
  assert.equal(next.turn, 3);
  assert.equal(next.step, 0);
  assert.equal(next.status, 'running');
});

test('a late actual result can settle an interrupted call without inventing an earlier result', () => {
  const reducer = createTraceReducer();
  const closed = run(reducer, [call(0, 'late', 'read', '{}', 10), end(1, 'interrupted', 1, {}, 20)]);
  const settled = reducer.apply(closed, result(2, 'late', 'actual output', {}, 30));
  assert.equal(closed.entries[0].status, 'interrupted');
  assert.equal(closed.entries[0].resultSeq, null);
  assert.equal(settled.entries.length, 2);
  assert.equal(settled.entries[0].status, 'completed');
  assert.equal(settled.entries[0].output, 'actual output');
  assert.equal(settled.entries[0].resultSeq, 2);
  assert.equal(settled.status, 'interrupted');
});

test('row bounds retain the last entries and evicted-call results do not double-count tools', () => {
  const reducer = createTraceReducer({ maxEntries: 2, maxDetailChars: 100 });
  const active = run(reducer, [call(0, 'evicted'), prompt(1, 'task'), update(2, 'update')]);
  assert.deepEqual(active.entries.map(row => row.kind), ['task', 'update']);
  assert.equal(active.dropped, 1);
  assert.equal(active.totalTools, 1);
  assert.equal(active.totalUpdates, 1);
  const state = reducer.apply(active, result(3, 'evicted', 'failed', {
    message: { isError: true }, data: { error: { name: 'Error', code: 'FAILED', reason: 'Public failure' } },
  }));
  assert.deepEqual(state.entries.map(row => row.kind), ['update', 'tool']);
  assert.equal(state.entries[1].callId, 'evicted');
  assert.equal(state.entries[1].status, 'error');
  assert.equal(state.entries[1].durationMs, null);
  assert.equal(state.dropped, 2);
  assert.equal(state.totalTools, 1);
  assert.equal(state.totalErrors, 1);
  assert.equal(active.entries[0].kind, 'task');
  assertPlainState(state);
});

test('aggregate retention budgets all retained string details, counts evictions, and keeps a single newest row', () => {
  const reducer = createTraceReducer({ maxEntries: 10, maxDetailChars: 900000 });
  const long = 'a'.repeat(250000);
  const state = run(reducer, [update(0, long), update(1, long), update(2, long)]);
  // Text alone is exactly 750000 chars, so titles must count toward the budget.
  assert.deepEqual(state.entries.map(row => row.seq), [1, 2]);
  assert.equal(state.dropped, 1);
  assert.equal(state.totalUpdates, 3);
  const huge = reducer.apply(state, prompt(3, 'b'.repeat(800000)));
  assert.equal(huge.entries.length, 1);
  assert.equal(huge.entries[0].seq, 3);
  assert.equal(huge.entries[0].text.length, 800000);
  assert.equal(huge.dropped, 3);
  const small = reducer.apply(huge, update(4, 'small public update'));
  assert.equal(small.entries.length, 1);
  assert.equal(small.entries[0].seq, 4);
  assert.equal(small.dropped, 4);
  const settled = run(reducer, [
    prompt(0, long), call(1, 'c', 'read', 'x'.repeat(200000)),
    result(2, 'c', 'y'.repeat(400000)),
  ]);
  assert.equal(settled.entries.length, 1);
  assert.equal(settled.entries[0].kind, 'tool');
  assert.equal(settled.entries[0].input.length, 200000);
  assert.equal(settled.entries[0].output.length, 400000);
  assert.equal(settled.dropped, 1);
  assertPlainState(settled);
});

test('text, input, and output are independently and deterministically bounded', () => {
  const reducer = createTraceReducer({ maxEntries: 10, maxDetailChars: 5 });
  const events = [
    prompt(0, 'abcdefgh'), call(1, 'c', 'read', '123456789'),
    result(2, 'c', 'abcdefgh', {
      message: { isError: true },
      data: { error: { name: 'Failure', code: 'FAILED', reason: 'public failure' } },
    }),
    update(3, 'abcde'),
  ];
  const state = run(reducer, events);
  assert.equal(state.entries[0].text, 'abcd…');
  assert.equal(state.entries[0].truncated, true);
  assert.equal(state.entries[1].input, '1234…');
  assert.equal(state.entries[1].output, 'abcd…');
  assert.equal(state.entries[1].text, 'Fail…');
  assert.equal(state.entries[1].truncated, true);
  assert.equal(state.entries[2].text, 'abcde');
  assert.equal(state.entries[2].truncated, false);
  for (const row of state.entries) {
    for (const key of ['text', 'input', 'output']) assert.ok(row[key].length <= 5);
  }
  assert.deepEqual(run(reducer, events), state);
});

test('small and zero limits stay bounded and truncation does not split a surrogate pair', () => {
  const reducer = createTraceReducer({ maxEntries: 1, maxDetailChars: 2 });
  const state = reducer.apply(reducer.init(HEADER), prompt(0, '😀abc'));
  assert.equal(state.entries[0].text, '…');
  assert.equal(state.entries[0].truncated, true);
  const hidden = createTraceReducer({ maxEntries: 1, maxDetailChars: 0 });
  const hiddenState = hidden.apply(hidden.init(HEADER), prompt(0, 'anything'));
  assert.equal(hiddenState.entries[0].text, '');
  assert.equal(hiddenState.entries[0].truncated, true);
  const none = createTraceReducer({ maxEntries: 0, maxDetailChars: 0 });
  const empty = run(none, [prompt(0, 'task'), call(1, 'c'), result(2, 'c', 'output'), end(3, 'completed')]);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.dropped, 4);
  assert.equal(empty.totalTools, 1);
  assert.equal(empty.status, 'completed');
});

test('limits are detached from options and invalid limits use defaults', () => {
  const options = { maxEntries: 3, maxDetailChars: 4 };
  const reducer = createTraceReducer(options);
  options.maxEntries = 0;
  options.maxDetailChars = 0;
  const first = reducer.init(HEADER);
  const second = reducer.init(HEADER);
  assert.deepEqual(first.limits, { maxEntries: 3, maxDetailChars: 4 });
  assert.notStrictEqual(first.limits, second.limits);
  assert.equal(reducer.apply(first, prompt(0, 'abcdef')).entries[0].text, 'abc…');
  for (const options of [{ maxEntries: -1, maxDetailChars: Infinity }, { maxEntries: 1.5, maxDetailChars: NaN }, null]) {
    assert.deepEqual(createTraceReducer(options).init(HEADER).limits, { maxEntries: 800, maxDetailChars: 12000 });
  }
});

test('a JSON checkpoint plus any event suffix equals full replay even after configuration changes', () => {
  const reducer = createTraceReducer({ maxEntries: 3, maxDetailChars: 9 });
  const events = [
    event('turn/start', 0, { turn: 1 }), prompt(1, 'a long public task'),
    event('step/start', 2, { turn: 1, step: 1 }),
    call(3, 'first', 'read', '{"path":"a-long-public-path"}', 100),
    call(4, 'second', 'list', '{}', 110),
    update(5, 'public update longer than limit'),
    result(6, 'second', 'listing longer than limit', {}, 120),
    result(7, 'first', '', {
      message: { isError: true, content: [] },
      data: { error: { name: 'ReadError', code: 'FAILED', reason: 'Public reason longer than limit' } },
    }, 130),
    end(8, 'error', 1, {}, 140),
    event('turn/start', 9, { turn: 2 }),
    event('step/start', 10, { turn: 2, step: 1 }),
    call(11, 'pending', 'read', '{}', 150, 2, 1),
    event('assistant/attempt', 12, { stream: [{ text: 'PRIVATE_STREAM' }] }),
    end(13, 'aborted', 2, {}, 160),
  ];
  const expected = run(reducer, events);
  const differentlyConfigured = createTraceReducer({ maxEntries: 99, maxDetailChars: 1 });
  for (let cut = 0; cut <= events.length; cut += 1) {
    const checkpoint = json(run(reducer, events.slice(0, cut)));
    const before = json(checkpoint);
    const actual = run(differentlyConfigured, events.slice(cut), checkpoint);
    assert.deepEqual(actual, expected, `checkpoint cut ${cut}`);
    assert.deepEqual(checkpoint, before, `checkpoint mutation at cut ${cut}`);
    assertPlainState(actual);
  }
  assert.deepEqual(expected.limits, { maxEntries: 3, maxDetailChars: 9 });
  assert.equal(expected.totalTools, 3);
  assert.equal(expected.totalUpdates, 1);
  assert.equal(expected.totalErrors, 2);
  assert.doesNotMatch(JSON.stringify(expected), /PRIVATE_/);
});

test('unknown, private, empty, malformed, and redundant events preserve the same state reference', () => {
  const reducer = createTraceReducer();
  const state = run(reducer, [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 })]);
  const ignored = [
    null, undefined, {}, { type: 'turn/start' },
    event('unknown/event', 2, { text: 'PRIVATE_UNKNOWN' }),
    event('system/message', 3, { message: { content: [text('PRIVATE_SYSTEM')] } }),
    event('developer/message', 4, { message: { content: [text('PRIVATE_DEVELOPER')] } }),
    event('assistant/stream', 5, { text: 'PRIVATE_STREAM' }),
    event('assistant/attempt', 6, { stream: [{ text: 'PRIVATE_ATTEMPT' }] }),
    event('request/header', 7, { header: { config: { system: 'PRIVATE_CONFIG' } } }),
    event('session/end-seed', 8, { inherited: true }),
    event('step/end', 9, { turn: 1, step: 1 }),
    event('step/start', 10, { turn: 1, step: 1 }),
    prompt(11, ''), update(12, ''),
    event('assistant/message', 13, { message: null }),
    event('tool/call', 14, { callId: 'bad', name: 'read', arguments: { private: 'PRIVATE_OBJECT_ARGS' } }),
    event('tool/result', 15, { message: null }),
    event('user/message', 16, { role: 'system', source: { kind: 'user' }, content: [text('PRIVATE_ROLE')] }),
  ];
  for (const item of ignored) assert.strictEqual(reducer.apply(state, item), state);
  const started = reducer.apply(state, event('turn/start', 17, { turn: 2 }));
  assert.strictEqual(reducer.apply(started, event('turn/start', 18, { turn: 2 })), started);
  assertPlainState(state);
});
