import assert from 'node:assert';
import test from 'node:test';
import * as F from '../src/facts.js';

const world = { cast: [{ id: 'a', name: 'Aqualad' }, { id: 'b', name: 'Superboy' }, { id: 'c', name: 'Miss Martian' }] };
const newChat = () => ({ facts: [] });

test('facts live on the chat, not the world', () => {
  const c1 = newChat();
  const c2 = newChat();
  F.addFact(c1, { text: 'The base is flooded', everyone: true });
  assert.equal(c1.facts.length, 1);
  assert.equal(c2.facts.length, 0, 'other chats are untouched');
});

test('addFact dedupes and merges knownBy / everyone', () => {
  const c = newChat();
  F.addFact(c, { text: 'Secret door exists', knownBy: ['a'] });
  F.addFact(c, { text: 'secret door exists', knownBy: ['b'], everyone: true });
  assert.equal(c.facts.length, 1);
  assert.ok(c.facts[0].everyone);
  assert.deepEqual(c.facts[0].knownBy.sort(), ['a', 'b']);
});

test('factsKnown gates by present cast, everyone always shown', () => {
  const c = newChat();
  F.addFact(c, { text: 'public', everyone: true });
  F.addFact(c, { text: 'aqualad knows', knownBy: ['a'] });
  F.addFact(c, { text: 'superboy knows', knownBy: ['b'] });
  const known = F.factsKnown(c, ['a']).map((f) => f.text);
  assert.ok(known.includes('public') && known.includes('aqualad knows'));
  assert.ok(!known.includes('superboy knows'), 'gated out when Superboy absent');
});

test('knownByNames resolves via the world roster', () => {
  const c = newChat();
  const f = F.addFact(c, { text: 'x', knownBy: ['a', 'c'] });
  assert.deepEqual(F.knownByNames(world, f).sort(), ['Aqualad', 'Miss Martian']);
  assert.deepEqual(F.knownByNames(world, { everyone: true }), ['everyone']);
});

test('update, delete, clear', () => {
  const c = newChat();
  const f = F.addFact(c, { text: 'old', knownBy: ['a'] });
  F.updateFact(c, f.id, { text: 'new', everyone: true });
  assert.equal(c.facts[0].text, 'new');
  assert.ok(c.facts[0].everyone);
  F.deleteFact(c, f.id);
  assert.equal(c.facts.length, 0);
  F.addFact(c, { text: 'y' });
  F.clearFacts(c);
  assert.equal(c.facts.length, 0);
});

test('seedFromWorld copies canon as seed-origin facts', () => {
  const c = newChat();
  const w = { cast: [], facts: [{ text: 'Sky is green', everyone: true, knownBy: [] }, { text: 'A knows', knownBy: ['a'] }] };
  F.seedFromWorld(c, w);
  assert.equal(c.facts.length, 2);
  assert.ok(c.facts.every((f) => f.origin === 'seed'));
});

test('provenance: auto-facts from discarded messages get pruned (the regenerate fix)', () => {
  const c = newChat();
  F.addFact(c, { text: 'world canon', everyone: true, origin: 'seed' });
  F.addFact(c, { text: 'player noted this', everyone: true, origin: 'manual' });
  F.addFact(c, { text: 'from message n1', everyone: true, origin: 'node1' });
  F.addFact(c, { text: 'from regenerated-away n2', everyone: true, origin: 'node2' });

  // active path currently contains node1 but NOT node2 (it was regenerated away)
  const { removed } = F.pruneOrphanFacts(c, ['root', 'node1']);
  assert.equal(removed, 1, 'one orphan pruned');
  const texts = c.facts.map((f) => f.text);
  assert.ok(texts.includes('world canon'), 'seed kept');
  assert.ok(texts.includes('player noted this'), 'manual kept');
  assert.ok(texts.includes('from message n1'), 'live node kept');
  assert.ok(!texts.includes('from regenerated-away n2'), 'orphaned node fact removed');
});

test('whoKnows filters by query', () => {
  const c = newChat();
  F.addFact(c, { text: 'The vault code is 1234', knownBy: ['a'] });
  F.addFact(c, { text: 'It is raining', everyone: true });
  const hits = F.whoKnows(c, world, 'vault');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].who, ['Aqualad']);
});
