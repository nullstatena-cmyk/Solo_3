/**
 * Room block + verbatim recall.  node test/room.test.js
 */

import assert from 'node:assert/strict';
import { buildRoomBlock, applyStaging, setBond } from '../src/room.js';
import { tokenize, rank, selectRecall, buildRecallBlock } from '../src/recall.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nroom block\n');

const artemis = { id: 'a', name: 'Artemis', pronoun: 'she', voice: 'flat, sarcastic, clipped' };
const conner = { id: 'c', name: 'Superboy', pronoun: 'he', voice: 'short declaratives, no small talk' };
const theo = { name: 'Theo Marsh', pronoun: 'he' };

it('carries a pronoun for every character', () => {
  const b = buildRoomBlock({ presentCast: [artemis, conner], persona: theo });
  assert.match(b.content, /Artemis \(she\)/);
  assert.match(b.content, /Superboy \(he\)/);
  assert.match(b.content, /Theo Marsh \(he\)/);
});

it('marks the persona as off-limits to the model', () => {
  const b = buildRoomBlock({ presentCast: [artemis], persona: theo });
  assert.match(b.content, /Theo Marsh \(he\) — the author's character\. Never write his dialogue/);
});

it('defaults to they when no pronoun is set', () => {
  const b = buildRoomBlock({ presentCast: [{ id: 'x', name: 'Rook' }] });
  assert.match(b.content, /Rook \(they\)/);
});

it('falls back to the head of personality when no voice tag is set', () => {
  const long = { id: 'y', name: 'Kaldur', personality: 'Formal and measured; never uses contractions; speaks in complete sentences even under pressure, which reads as calm' };
  const b = buildRoomBlock({ presentCast: [long] });
  assert.match(b.content, /Voice: Formal and measured/);
  assert.match(b.content, /…/, 'truncated rather than dumping the whole field');
});

it('includes staging and bond when the scene has them', () => {
  const scene = { staging: { a: 'behind the van, bow half-drawn' }, bonds: { a: "wary, doesn't buy the kid act" } };
  const b = buildRoomBlock({ presentCast: [artemis], persona: theo, scene });
  assert.match(b.content, /behind the van, bow half-drawn/);
  assert.match(b.content, /→ Theo Marsh: wary, doesn't buy the kid act\./);
});

it('still renders usefully with no scene data at all', () => {
  const b = buildRoomBlock({ presentCast: [artemis] });
  assert.match(b.content, /Artemis \(she\)/);
  assert.match(b.content, /Voice: flat, sarcastic, clipped/);
});

it('emits the guard when any present character is flagged a minor', () => {
  const b = buildRoomBlock({ presentCast: [{ ...artemis, minor: true }, conner], persona: theo });
  assert.match(b.content, /Artemis is a minor/);
  assert.match(b.content, /no romantic or sexual content/i);
});

it('collapses the guard when everyone present is a minor', () => {
  const b = buildRoomBlock({
    presentCast: [{ ...artemis, minor: true }, { ...conner, minor: true }],
    persona: { ...theo, minor: true },
  });
  assert.match(b.content, /Everyone present is a minor/);
});

it('emits no guard when nobody is flagged', () => {
  const b = buildRoomBlock({ presentCast: [artemis, conner], persona: theo });
  assert.doesNotMatch(b.content, /minor/i);
});

it('punctuates cleanly whichever fields are missing', () => {
  const scene = { staging: { c: 'up, between the slab and the bus' } };
  const b = buildRoomBlock({ presentCast: [artemis, conner], persona: theo, scene });
  assert.match(b.content, /Artemis \(she\) — Voice: flat, sarcastic, clipped\./, 'no staging: still one clean sentence');
  assert.match(b.content, /Superboy \(he\) — up, between the slab and the bus\. Voice: short declaratives, no small talk\./);
  assert.doesNotMatch(b.content, /\)\s+Voice/, 'never runs the name straight into the voice tag');
  assert.doesNotMatch(b.content, /\.\./, 'no doubled full stops');
});

it('does not put a full stop after a truncated voice fallback', () => {
  const long = { id: 'z', name: 'Kaldur', personality: 'Formal and measured and given to long careful sentences that keep going well past any reasonable point' };
  const b = buildRoomBlock({ presentCast: [long] });
  assert.doesNotMatch(b.content, /…\./);
});

it('returns null with nothing to describe', () => {
  assert.equal(buildRoomBlock({ presentCast: [], persona: null }), null);
});

it('applyStaging resolves names to ids and drops unknowns', () => {
  const next = applyStaging({}, { Artemis: 'on the roof', Nobody: 'somewhere' }, (n) => (n === 'Artemis' ? 'a' : null));
  assert.deepEqual(next.staging, { a: 'on the roof' });
});

it('setBond sets and clears', () => {
  let s = setBond({}, 'a', 'wary');
  assert.equal(s.bonds.a, 'wary');
  s = setBond(s, 'a', '   ');
  assert.equal(s.bonds.a, undefined);
});

console.log('\nverbatim recall\n');

it('tokenize drops stopwords and single characters', () => {
  assert.deepEqual(tokenize('The slab was in the wall of a laundromat'), ['slab', 'wall', 'laundromat']);
});

it('ranks the turn that actually mentions the query terms', () => {
  const docs = [
    { id: '1', text: 'They ate breakfast and argued about nothing.' },
    { id: '2', text: 'The hydrant on Fourth Street went up in a white column.' },
    { id: '3', text: 'Someone laughed at a joke.' },
  ];
  const r = rank(docs, 'what happened to the hydrant');
  assert.equal(r[0].id, '2');
});

it('saturates term frequency rather than rewarding repetition', () => {
  const docs = [
    { id: 'spam', text: `Amazo ${'Amazo '.repeat(40)}` },
    { id: 'real', text: 'Amazo tore the roadbed up and threw it sidearm at the bus.' },
  ];
  const r = rank(docs, 'Amazo threw the roadbed at the bus');
  assert.equal(r[0].id, 'real', 'a genuine match beats keyword stuffing');
});

it('scores nothing when no query term appears', () => {
  const r = rank([{ id: '1', text: 'entirely unrelated content here' }], 'hydrant slab laundromat');
  assert.deepEqual(r, []);
});

it('handles an empty corpus and an empty query', () => {
  assert.deepEqual(rank([], 'anything'), []);
  assert.deepEqual(rank([{ id: '1', text: 'something' }], ''), []);
});

it('selectRecall returns hits in chronological order, not rank order', () => {
  const folded = [
    { id: '1', role: 'user', content: 'The hydrant was still running on Fourth Street.' },
    { id: '2', role: 'assistant', content: 'Unrelated filler about breakfast.' },
    { id: '3', role: 'assistant', content: 'Water from the hydrant pooled around the bus.' },
  ];
  const picked = selectRecall(folded, 'hydrant', { maxTokens: 500, topK: 5 });
  assert.deepEqual(picked.map((p) => p.id), ['1', '3']);
});

it('respects the token budget and keeps trying smaller candidates', () => {
  const folded = [
    { id: 'big', role: 'assistant', content: `hydrant ${'padding '.repeat(400)}` },
    { id: 'small', role: 'assistant', content: 'hydrant, briefly.' },
  ];
  const picked = selectRecall(folded, 'hydrant', { maxTokens: 60, topK: 5 });
  assert.deepEqual(picked.map((p) => p.id), ['small']);
});

it('returns the original words, not a paraphrase', () => {
  const folded = [{ id: '1', role: 'user', content: 'He said the word "crucible" and did not explain it.' }];
  const block = buildRecallBlock(selectRecall(folded, 'crucible'), { personaName: 'Theo' });
  assert.match(block.content, /He said the word "crucible" and did not explain it\./);
});

it('labels recall as out of order so the scene does not resume from it', () => {
  const block = buildRecallBlock([{ id: '1', role: 'user', content: 'x' }], {});
  assert.match(block.content, /out of order/i);
  assert.match(block.content, /does not resume/i);
});

it('builds nothing when there is nothing to recall', () => {
  assert.equal(buildRecallBlock([], {}), null);
  assert.deepEqual(selectRecall([], 'anything'), []);
});

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(f.err);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
