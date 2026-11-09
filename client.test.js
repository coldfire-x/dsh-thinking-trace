import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let declaration;
vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { declaration = value; } } },
});
// The factory's pure helpers and registrations require no React execution.
const plugin = declaration.factory(() => { throw new Error('Unexpected React or DOM use in pure helper test'); });
const { selectNotes, openRelatedAction } = plugin;
const plain = value => JSON.parse(JSON.stringify(value));
const update = (seq, turn = 1, step = 1, text = 'I will check the public interface.') => ({
  id: `update:${seq}`, seq, time: seq * 100, turn, step, kind: 'update', text, truncated: false,
});
const tool = (seq, callId, turn = 1, step = 1) => ({
  id: `tool:${seq}`, seq, turn, step, kind: 'tool', callId, name: 'read',
  input: 'RAW_INPUT', output: 'RAW_OUTPUT', status: 'completed',
});

test('notes contain only recorded public update text and minimal navigation fields', () => {
  const entries = [
    { ...update(0), kind: 'task', text: 'USER_TASK' },
    { ...update(1), text: 'Public explanation', reasoning: 'PRIVATE_REASONING', replayState: 'PRIVATE_REPLAY' },
    tool(2, 'call-a'),
    { ...update(3), kind: 'outcome', text: 'TURN_STATUS' },
    { ...update(4), kind: 'reasoning', text: 'PRIVATE_REASONING' },
    update(5, 1, 2, '  '),
  ];
  const before = JSON.stringify(entries);
  const notes = plain(selectNotes(entries));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'Public explanation');
  assert.deepEqual(notes[0].action, { callId: 'call-a', seq: 2 });
  assert.doesNotMatch(JSON.stringify(notes), /USER_TASK|PRIVATE_|RAW_|TURN_STATUS/);
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(plain(selectNotes(undefined)), []);
});

test('related actions match exact Turn and Step and select the first recorded call', () => {
  const entries = [
    update(0, 1, 1), tool(1, 'one', 1, 1),
    update(2, 1, 2), tool(4, 'later', 1, 2), tool(3, 'first', 1, 2),
    update(5, 2, 1), tool(6, 'other-turn', 2, 1),
    update(7, 3, 1),
  ];
  const notes = plain(selectNotes(entries));
  assert.deepEqual(notes.map(note => note.seq), [0, 2, 5, 7]);
  assert.deepEqual(notes.map(note => note.action?.callId || null), ['one', 'first', 'other-turn', null]);
});

test('evicted calls and nearby calls in other Steps do not create inferred associations', () => {
  const notes = plain(selectNotes([
    update(3, 1, 2),
    tool(2, 'previous-step', 1, 1),
    { ...tool(4, 'orphan-result', 1, 2), name: '', input: '' },
    { ...tool(5, '', 1, 2) },
    tool(6, 'next-step', 1, 3),
  ]));
  assert.equal(notes[0].action, null);
});

test('history is loaded before switching to Trajectory with the exact call ID', async () => {
  const order = [];
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const opening = openRelatedAction({ callId: 'chosen', seq: 50 }, async seq => {
    order.push(['load', seq]);
    await loading;
  }, (...args) => order.push(['open', ...args]), () => true);
  assert.deepEqual(order, [['load', 50]]);
  release();
  assert.equal(await opening, true);
  assert.deepEqual(order, [['load', 50], ['open', 'trajectory', 'chosen']]);
});

test('a cancelled or superseded navigation never opens a different view', async () => {
  const opened = [];
  assert.equal(await openRelatedAction({ callId: 'old', seq: 7 }, async () => {}, (...args) => opened.push(args), () => false), false);
  assert.deepEqual(opened, []);
  assert.equal(await openRelatedAction(null, async () => {}, () => {}, () => true), false);
});

test('history failures remain failures rather than claiming successful navigation', async () => {
  const opened = [];
  await assert.rejects(openRelatedAction({ callId: 'missing', seq: 7 }, async () => {
    throw new Error('History unavailable');
  }, (...args) => opened.push(args), () => true), /History unavailable/);
  assert.deepEqual(opened, []);
});

test('slot remains after Trajectory for all sessions and loads each session independently', async () => {
  let registration;
  const dictionaries = {};
  const loaded = [];
  const sessions = new Map(['session-a', 'session-b'].map(id => [id, {
    session: { loadThrough: async seq => { loaded.push([id, seq]); }, getSnapshot: () => ({ removed: false, openError: null }) },
  }]));
  plugin.apply({
    effect: factory => factory(),
    locale: {
      register: (_ns, locale, dictionary) => { dictionaries[locale] = dictionary; return () => {}; },
      bind: () => key => dictionaries.en[key],
    },
    sessions: { binding: id => sessions.get(id) },
    slots: {
      inject: (_name, factory) => factory(),
      register: options => { registration = options; return () => {}; },
    },
  });
  assert.equal(registration.name, 'conversation.view');
  assert.equal(registration.id, 'decision-trace');
  assert.equal(registration.order, 20);
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  await registration.inject('session-a').loadAction(50);
  await registration.inject('session-b').loadAction(0);
  assert.deepEqual(loaded, [['session-a', 49], ['session-b', 0]]);
  await assert.rejects(registration.inject('closed-session').loadAction(1), /no longer open/);
});
