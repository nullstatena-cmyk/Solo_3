/**
 * Prompt-building tests.  node test/prompt.test.js
 */

import assert from 'node:assert/strict';
import { createChat, addMessage } from '../src/tree.js';
import {
  buildSystemPrompt, buildApiMessages, trimToBudget, fillPlaceholders, estimateTokens,
} from '../src/prompt.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nprompt building\n');

const character = {
  name: 'Vex',
  description: 'A wry starship engineer.',
  personality: 'sardonic, loyal, allergic to sentiment',
  scenario: 'The ship is adrift and the reactor is failing.',
  exampleDialogue: '{{user}}: What now?\n{{char}}: Now we panic. Productively.',
};
const persona = { name: 'Commander Hale', description: 'the exhausted captain' };

it('the system prompt weaves in every character field', () => {
  const s = buildSystemPrompt({ character, persona });
  assert.match(s, /You are Vex/);
  assert.match(s, /wry starship engineer/);
  assert.match(s, /sardonic, loyal/);
  assert.match(s, /reactor is failing/);
  assert.match(s, /Commander Hale/);
});

it('{{char}} and {{user}} are filled in, including inside example dialogue', () => {
  const s = buildSystemPrompt({ character, persona });
  assert.match(s, /Commander Hale: What now\?/);
  assert.match(s, /Vex: Now we panic/);
  assert.ok(!s.includes('{{'), 'no placeholders should survive');
});

it('a system prefix (the jailbreak/style note) leads the prompt', () => {
  const s = buildSystemPrompt({ character, persona, settings: { systemPrefix: 'Write vividly and never break character.' } });
  assert.ok(s.startsWith('Write vividly'), s.slice(0, 40));
});

it('a bare character still produces something usable', () => {
  assert.equal(buildSystemPrompt({ character: {} }), '');
  assert.match(buildSystemPrompt({ character: { description: 'just vibes' } }), /just vibes/);
});

it('the active path becomes user/assistant turns after the system message', () => {
  const chat = createChat();
  addMessage(chat, { role: 'assistant', content: 'The lights flicker.', parentId: null });
  addMessage(chat, { role: 'user', content: 'I check the panel.' });
  const msgs = buildApiMessages({ chat, character, persona });

  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['assistant', 'user']);
  assert.equal(msgs[2].content, 'I check the panel.');
});

it('placeholders in message content are filled too', () => {
  const chat = createChat();
  addMessage(chat, { role: 'assistant', content: 'Hold on, {{user}}.', parentId: null });
  const msgs = buildApiMessages({ chat, character, persona });
  assert.equal(msgs[1].content, 'Hold on, Commander Hale.');
});

it('estimateTokens grows with length', () => {
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

it('trimming drops the oldest turns but keeps the system message and the last turn', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(40) },
    { role: 'user', content: 'old'.repeat(200) },
    { role: 'assistant', content: 'mid'.repeat(200) },
    { role: 'user', content: 'newest' },
  ];
  const trimmed = trimToBudget(messages, 60); // tiny budget
  assert.equal(trimmed[0].role, 'system', 'system is pinned');
  assert.equal(trimmed.at(-1).content, 'newest', 'the latest turn survives');
  assert.ok(trimmed.length < messages.length, 'something was dropped');
});

it('trimming with no budget leaves everything alone', () => {
  const messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }];
  assert.deepEqual(trimToBudget(messages, 0), messages);
});

it('fillPlaceholders tolerates empty input', () => {
  assert.equal(fillPlaceholders('', { charName: 'X' }), '');
  assert.equal(fillPlaceholders(undefined, {}), '');
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);

test("author's note is injected last and survives budget trimming", () => {
  const world = { id: 'w', name: 'W', cast: [{ id: 'c1', name: 'Mara', description: 'A guide.' }], facts: [], lorebook: [] };
  const chat = { presentCast: ['c1'], nodes: {}, rootIds: [], activeChild: {} };
  // build a chat with enough turns that trimming will bite
  let parent = null;
  for (let i = 0; i < 12; i++) {
    const id = `n${i}`;
    chat.nodes[id] = { id, parentId: parent, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'padding '.repeat(40)}`, ts: i };
    if (parent === null) chat.rootIds.push(id); else chat.activeChild[parent] = id;
    parent = id;
  }
  const msgs = prompt.buildWorldMessages({
    chat, world, settings: { contextTokens: 700 }, authorNote: 'Beat order: speech, reactions, action.',
  });
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'system', 'note is a system message');
  assert.match(last.content, /Beat order: speech, reactions, action\./);
  assert.match(last.content, /Author's note/i);
  assert.ok(msgs.length >= 3, 'trimming still happened around it');

  const none = prompt.buildWorldMessages({ chat, world, settings: { contextTokens: 700 } });
  assert.ok(!/Author's note/i.test(none[none.length - 1].content), 'no note message when empty');
});

test('buildOocMessages frames an out-of-character assistant with scene knowledge', () => {
  const msgs = prompt.buildOocMessages({
    world: { name: 'Earth-16', description: 'Superheroes.' },
    presentCast: [
      { name: 'Superboy', description: 'A clone.', personality: 'Terse. Inner voice: physical, wordless.' },
      { name: 'Robin', description: 'A detective.', personality: 'Playful. Inner voice: checklists.' },
    ],
    persona: { name: 'Theo', description: 'Adaptive meta.' },
    facts: [{ text: 'Theo adapted to electricity.', knownByNames: ['Superboy'] }],
    scene: { clock: 5, present: ['Superboy', 'Robin'], away: [] },
    summary: 'A bus was nearly crushed.',
    transcript: ['Scene: Amazo advanced.'],
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
    question: 'What is each of them thinking?',
  });

  const sys = msgs[0].content;
  assert.equal(msgs[0].role, 'system');
  assert.match(sys, /out-of-character/i);
  assert.match(sys, /Do NOT advance the story/i);
  assert.match(sys, /distinct interiority/i);
  assert.match(sys, /Superboy/);
  assert.match(sys, /Inner voice: checklists/);
  assert.match(sys, /Theo adapted to electricity/);
  assert.match(sys, /known by: Superboy/);
  assert.match(sys, /0:05/, 'scene clock included');
  assert.match(sys, /A bus was nearly crushed/);

  // prior OOC history is carried, then the new question is last
  assert.equal(msgs[1].content, 'earlier question');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs.at(-1).content, 'What is each of them thinking?');
  assert.equal(msgs.at(-1).role, 'user');
});

test('buildOocMessages works with almost nothing supplied', () => {
  const msgs = prompt.buildOocMessages({ question: 'hi' });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /writers'-room|out-of-character/i);
});
