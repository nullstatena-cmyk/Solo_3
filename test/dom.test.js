/**
 * DOM smoke test (worlds).
 *
 * Loads the real index.html and app.js into jsdom and drives the whole world flow:
 * a starter world with a cast, a scene, setting the scene, sending a message and
 * watching a reply stream in, the background memory extraction filing a fact
 * (gated to who's present), a slash-command changing the roster, /remember, the
 * memory panel + summarization, regenerate/branch/delete, creating a second world,
 * and finally that everything persisted. The network is scripted: streaming
 * requests get an RP reply; the non-streaming memory/summary calls get JSON.
 *
 *   node test/dom.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsdomPkg from 'jsdom';
const { JSDOM } = jsdomPkg;

class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  key(i) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

let rpCalls = 0;
function makeFetch() {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const sys = body.messages[0]?.content || '';
    if (body.stream === false) {
      let content = 'ok';
      if (/extract durable story facts/i.test(sys)) content = '{"facts": ["Mara distrusts strangers who arrive on the wrong tide."]}';
      else if (/story so far/i.test(sys)) content = 'The newcomer reached Saltcombe and met Mara at the dock.';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    rpCalls += 1;
    const text = `Reply ${rpCalls}.`;
    const parts = [text.slice(0, 3), text.slice(3)];
    const sse = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = new MemStore();
globalThis.fetch = makeFetch();

const { state } = await import('../src/app.js');
const tree = await import('../src/tree.js');
const storage = await import('../src/storage.js');

let passed = 0;
const failures = [];
async function it(name, fn) {
  try { await fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

const $ = (id) => dom.window.document.getElementById(id);
const q = (sel) => dom.window.document.querySelector(sel);
const qa = (sel) => [...dom.window.document.querySelectorAll(sel)];
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred, label = 'condition') {
  for (let i = 0; i < 300; i += 1) { if (pred()) { await tick(); return; } await tick(); }
  throw new Error(`timed out waiting for ${label}`);
}
const path = () => (state.activeChat ? tree.activePath(state.activeChat) : []);
const last = () => path().at(-1);
const lastContent = () => last()?.content ?? '';
const facts = () => state.activeChat.facts;

let hollowId; let maraId; let finnId; let hollowSceneId;

console.log('\ndom smoke test (worlds)\n');

await it('boots with the starter world and its cast', () => {
  assert.equal(state.activeWorld.name, 'The Hollow Coast');
  const names = state.activeWorld.cast.map((c) => c.name);
  assert.deepEqual(names, ['Mara', 'Finn']);
  assert.equal(state.activeChat, null);
  assert.match($('world-switch-name').textContent, /Hollow Coast/);
  hollowId = state.activeWorld.id;
  maraId = state.activeWorld.cast[0].id;
  finnId = state.activeWorld.cast[1].id;
});

await it('a new scene starts empty and you pick who is in it', () => {
  state.settings.apiKey = 'test-key';
  state.settings.director = false; // exercise the deterministic command path, not the LLM director
  $('btn-new-chat').click();
  assert.ok(state.activeChat);
  hollowSceneId = state.activeChatId;
  assert.equal(state.activeChat.presentCast.length, 0, 'no one loaded until you choose');
  assert.ok(state.activeChat.sceneState, 'scene has a director state');
  assert.ok(Array.isArray(state.activeChat.facts), 'scene has its own fact store');
  assert.equal(path().length, 0, 'empty until opened');
  // pick the cast from the scene director panel
  $('btn-scene').click();
  assert.equal(qa('[data-leave]').length, 0, 'nobody on stage yet');
  q(`[data-add-present="${maraId}"]`).click(); // re-renders the panel
  q(`[data-add-present="${finnId}"]`).click(); // fresh element after re-render
  assert.deepEqual([...state.activeChat.presentCast].sort(), [maraId, finnId].sort(), 'both now in scene');
  const close = q('[data-close]');
  if (close) close.click();
});

await it('“set the scene” opens with a generated line', async () => {
  $('btn-opening').click();
  await waitFor(() => lastContent() === 'Reply 1.', 'opening line');
  assert.equal(path().length, 1);
  assert.equal(last().role, 'assistant');
});

await it('sending a message streams a reply and the memory files a fact', async () => {
  $('input').value = 'I need passage north, harbormaster.';
  $('btn-send').click();
  await waitFor(() => lastContent() === 'Reply 2.', 'reply');
  await waitFor(() => facts().length >= 1, 'extracted fact');

  assert.equal(path().length, 3, 'opening, user, reply');
  const fact = facts().find((f) => /distrusts strangers/.test(f.text));
  assert.ok(fact, 'the extracted fact is filed');
  assert.deepEqual([...fact.knownBy].sort(), [maraId, finnId].sort(), 'known by everyone present');
});

await it('/leave removes a character from the scene', async () => {
  $('input').value = '/leave Finn';
  $('btn-send').click();
  await tick();
  assert.ok(!state.activeChat.presentCast.includes(finnId), 'Finn left');
  $('btn-scene').click();
  assert.equal(qa('[data-leave]').length, 1);
  q('[data-close]').click();
});

await it('the scene menu adds and removes cast, and the header summary updates', () => {
  $('btn-scene').click();
  q(`[data-add-present="${finnId}"]`).click();           // add Finn back
  assert.ok(state.activeChat.presentCast.includes(finnId), 'Finn re-added');
  q(`[data-leave="${finnId}"]`).click();                 // remove him again (menu re-rendered)
  assert.ok(!state.activeChat.presentCast.includes(finnId), 'Finn removed again');
  assert.match($('scene-summary').textContent, /1 present/, 'header summary reflects the roster');
  const close = q('[data-close]');
  if (close) close.click();
});

await it('/remember files a fact gated to who is now present', async () => {
  $('input').value = '/remember The bridge north is washed out.';
  $('btn-send').click();
  await tick();
  const fact = facts().find((f) => /bridge north/.test(f.text));
  assert.ok(fact, 'fact recorded');
  assert.deepEqual(fact.knownBy, [maraId], 'only Mara is present, so only Mara knows');
  assert.equal(facts().length, 2);
});

await it('the memory panel shows facts and can summarize', async () => {
  $('btn-memory').click();
  assert.ok(!$('modal-root').classList.contains('hidden'));
  assert.match($('modal-root').textContent, /bridge north is washed out/);
  q('[data-summarize]').click();
  await waitFor(() => !!state.activeChat.summary, 'summary written');
  assert.match(state.activeChat.summary, /reached Saltcombe/);
  // close whatever memory modal is open
  const close = q('[data-close]');
  if (close) close.click();
});

await it('regenerating still works inside a scene', async () => {
  $('btn-regenerate').click();
  await waitFor(() => lastContent() === 'Reply 3.', 'regenerated');
  assert.equal(tree.siblingInfo(state.activeChat, last().id).count, 2);
});

await it('branching forks a new scene in the same world', () => {
  const before = state.activeChatId;
  qa('.msg.assistant').pop().querySelector('[data-action="branch"]').click();
  assert.notEqual(state.activeChatId, before);
  assert.equal(state.chatMetas.filter((m) => m.worldId === hollowId).length, 2);
  assert.deepEqual(state.activeChat.presentCast, [maraId], 'roster carried into the fork');
});

await it('deleting a message works and confirms', () => {
  const lenBefore = path().length;
  qa('.msg.assistant').pop().querySelector('[data-action="delete"]').click();
  assert.ok(!$('modal-root').classList.contains('hidden'));
  q('[data-confirm]').click();
  assert.equal(path().length, lenBefore - 1);
});

await it('the scene director tracks time, away-status, and timed arrivals', async () => {
  $('btn-new-chat').click(); // fresh Hollow Coast scene: starts empty
  const chat = state.activeChat;
  assert.equal(chat.sceneState.clock, 0);
  $('input').value = '/enter Mara, Finn'; $('btn-send').click(); await tick();
  assert.equal(chat.sceneState.present.length, 2, 'both brought on stage');

  $('input').value = '/away Finn'; $('btn-send').click(); await tick();
  assert.ok(chat.sceneState.away.includes(finnId), 'Finn sent elsewhere');
  assert.ok(!chat.sceneState.present.includes(finnId), 'and off stage');

  $('input').value = '/schedule 5 Finn returns from the docks: Finn'; $('btn-send').click(); await tick();
  assert.equal(chat.sceneState.pending.length, 1, 'event scheduled');
  assert.equal(chat.sceneState.pending[0].at, 300, 'scheduled at clock + 5 minutes, in seconds');

  $('input').value = '/wait 5'; $('btn-send').click();
  await waitFor(() => chat.sceneState.clock >= 300 && chat.sceneState.present.includes(finnId), 'time passed and Finn returned');
  assert.equal(chat.sceneState.pending.length, 0, 'the timed event fired');
});

await it('a second world can be created and becomes active', () => {
  $('world-switch').click();
  q('[data-new-world]').click();
  q('#w-name').value = 'Neon Sprawl';
  q('[data-save-world]').click();
  assert.equal(state.activeWorld.name, 'Neon Sprawl');
  assert.equal(state.worldMetas.length, 2);
  const close = q('[data-close]');
  if (close) close.click();
});

await it('everything persisted (a reload would restore it)', () => {
  const index = storage.loadIndex();
  assert.equal(index.worldMetas.length, 2);
  const hollow = storage.loadWorld(hollowId);
  assert.ok(hollow, 'world saved');
  // facts now live on the chat, not the world
  const scene = storage.loadChat(hollowSceneId);
  assert.ok(scene, 'scene saved');
  assert.equal(scene.facts.length, 2, 'both facts persisted on the scene with their gating');
  assert.ok(scene.facts.find((f) => /bridge/.test(f.text)).knownBy.length === 1, 'bridge fact stayed gated to Mara');
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
