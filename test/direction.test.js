/**
 * Authorial direction tests.  node test/direction.test.js
 */

import assert from 'node:assert/strict';
import { splitDirection, hasDirection, buildDirectionMessage } from '../src/direction.js';
import { buildWorldMessages } from '../src/prompt.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nauthorial direction\n');

/* ── the scanner ──────────────────────────────────────────────────────────── */

it('lifts a bracketed span out of the spoken text', () => {
  const r = splitDirection("Move. He shoves her clear. [The others don't reach her in time.]");
  assert.equal(r.spoken, 'Move. He shoves her clear.');
  assert.deepEqual(r.directions, ["The others don't reach her in time."]);
});

it('inlines the same span as plain narration for played turns', () => {
  const r = splitDirection("Move. [The others don't reach her in time.]");
  assert.equal(r.inlined, "Move. The others don't reach her in time.");
});

it('handles several spans in one message', () => {
  const r = splitDirection('Two [first] separate [second] spans.');
  assert.equal(r.spoken, 'Two separate spans.');
  assert.deepEqual(r.directions, ['first', 'second']);
});

it('keeps nested brackets whole', () => {
  const r = splitDirection('Nested [outer [inner] rest] case.');
  assert.deepEqual(r.directions, ['outer [inner] rest']);
  assert.equal(r.spoken, 'Nested case.');
});

it('leaves an unclosed bracket verbatim rather than eating the line', () => {
  const raw = 'Unclosed [this must survive';
  const r = splitDirection(raw);
  assert.equal(r.spoken, raw);
  assert.deepEqual(r.directions, []);
});

it('leaves a stray closer alone', () => {
  const r = splitDirection('Stray ] closer stays.');
  assert.equal(r.spoken, 'Stray ] closer stays.');
  assert.deepEqual(r.directions, []);
});

it('treats escaped brackets as literal text', () => {
  const r = splitDirection('Escaped \\[not a direction\\] literal.');
  assert.equal(r.spoken, 'Escaped [not a direction] literal.');
  assert.deepEqual(r.directions, []);
});

it('drops empty spans', () => {
  const r = splitDirection('Empty [] and [   ] spans.');
  assert.deepEqual(r.directions, []);
  assert.equal(r.spoken, 'Empty and spans.');
});

it('hasDirection reports only real spans', () => {
  assert.equal(hasDirection('plain text'), false);
  assert.equal(hasDirection('with [one]'), true);
  assert.equal(hasDirection('escaped \\[one\\]'), false);
});

it('builds nothing when there are no directions', () => {
  assert.equal(buildDirectionMessage([]), null);
  assert.equal(buildDirectionMessage(['', '   ']), null);
});

it('builds a system message that forbids softening and names the opening slot', () => {
  const m = buildDirectionMessage(['He takes the blow.']);
  assert.equal(m.role, 'system');
  assert.match(m.content, /He takes the blow\./);
  assert.match(m.content, /soften/i);
  assert.match(m.content, /Begin your reply by narrating it/i);
});

/* ── integration with buildWorldMessages ──────────────────────────────────── */

const world = { id: 'w', name: 'W', cast: [{ id: 'c1', name: 'Mara', description: 'A guide.' }], facts: [], lorebook: [] };

function chatOf(turns) {
  const chat = { presentCast: ['c1'], nodes: {}, rootId: null };
  let parent = null;
  turns.forEach(([role, content], i) => {
    const id = `n${i}`;
    chat.nodes[id] = { id, parentId: parent, role, content, ts: i, activeChild: null };
    if (parent === null) chat.rootId = id; else chat.nodes[parent].activeChild = id;
    parent = id;
  });
  return chat;
}

it('hoists the newest turn’s direction into the last prompt slot', () => {
  const chat = chatOf([
    ['user', 'Hello.'],
    ['assistant', 'She nods.'],
    ['user', "Move. [The others don't reach her in time.]"],
  ]);
  const msgs = buildWorldMessages({ chat, world });
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /Authorial direction/i);
  assert.match(last.content, /don't reach her in time/);

  const user = msgs[msgs.length - 2];
  assert.equal(user.role, 'user');
  assert.equal(user.content, 'Move.', 'brackets are gone from the turn being answered');
});

it('sits after the author’s note, closest to the generation point', () => {
  const chat = chatOf([['user', 'Go. [He is already down.]']]);
  const msgs = buildWorldMessages({ chat, world, authorNote: 'Keep it terse.' });
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];
  assert.match(last.content, /Authorial direction/i);
  assert.match(prev.content, /Author's note/i);
});

it('renders played turns as narration instead of brackets', () => {
  const chat = chatOf([
    ['user', 'Move. [He takes the blow.]'],
    ['assistant', 'The blow lands.'],
    ['user', 'What now?'],
  ]);
  const msgs = buildWorldMessages({ chat, world });
  const first = msgs.find((m) => m.role === 'user');
  assert.equal(first.content, 'Move. He takes the blow.');
  assert.ok(!msgs.some((m) => /Authorial direction/i.test(m.content)), 'no stale direction from an old turn');
});

it('omits the user turn entirely when the message is direction-only', () => {
  const chat = chatOf([
    ['user', 'Hi.'],
    ['assistant', 'Hi back.'],
    ['user', '[He is already unconscious when they find him.]'],
  ]);
  const msgs = buildWorldMessages({ chat, world });
  const last = msgs[msgs.length - 1];
  assert.match(last.content, /Authorial direction/i);
  assert.equal(msgs[msgs.length - 2].role, 'assistant', 'no empty user turn left behind');
});

it('survives budget trimming', () => {
  const turns = [];
  for (let i = 0; i < 12; i++) turns.push([i % 2 ? 'assistant' : 'user', `turn ${i} ${'padding '.repeat(40)}`]);
  turns.push(['user', 'Now. [She is already gone.]']);
  const msgs = buildWorldMessages({ chat: chatOf(turns), world, settings: { contextTokens: 700 } });
  assert.match(msgs[msgs.length - 1].content, /She is already gone/);
});

it('leaves ordinary messages untouched', () => {
  const chat = chatOf([['user', 'Just talking.']]);
  const msgs = buildWorldMessages({ chat, world });
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'Just talking.');
});

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(f.err);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
