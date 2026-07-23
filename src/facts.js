// facts.js — each CHAT owns its own fact store, so two scenes never share memory.
//
// Every fact carries provenance in `origin`:
//   'seed'   — copied from the world's canon when the chat was created
//   'manual' — the player filed it (/remember, /correct, or the memory panel)
//   <nodeId> — auto-extracted from a specific assistant message
//
// Because auto-facts are tied to the message that produced them, regenerating,
// editing, or deleting that message can prune the facts that came from discarded
// text — so a throwaway generation never leaves canon behind to warp the scene.

const fid = () => `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function ensureFactStore(chat) {
  if (!chat) return [];
  if (!Array.isArray(chat.facts)) chat.facts = [];
  return chat.facts;
}

export function addFact(chat, { text, knownBy = [], everyone = false, origin = 'manual' } = {}) {
  const clean = String(text || '').trim();
  if (!clean || !chat) return null;
  ensureFactStore(chat);
  const existing = chat.facts.find((f) => f.text.toLowerCase() === clean.toLowerCase());
  if (existing) {
    if (everyone) existing.everyone = true;
    for (const id of knownBy) if (!existing.knownBy.includes(id)) existing.knownBy.push(id);
    return existing;
  }
  const fact = { id: fid(), text: clean, knownBy: [...new Set(knownBy)], everyone: !!everyone, origin, ts: Date.now() };
  chat.facts.push(fact);
  return fact;
}

/** Reveal a fact to everyone currently present — the propagation rule. */
export function revealToPresent(chat, text, presentCast, origin = 'manual') {
  return addFact(chat, { text, knownBy: presentCast, origin });
}

/** The facts this scene's present cast actually know (everyone-facts always included). */
export function factsKnown(chat, presentCast) {
  const present = new Set(presentCast || []);
  return (chat?.facts || []).filter((f) => f.everyone || (f.knownBy || []).some((id) => present.has(id)));
}

/** Which characters know a fact, as names (needs the world for the roster). */
export function knownByNames(world, fact) {
  if (fact.everyone) return ['everyone'];
  return (fact.knownBy || []).map((id) => world?.cast.find((c) => c.id === id)?.name).filter(Boolean);
}

/** Answer "/whoknows <query>": matching facts and who holds them. */
export function whoKnows(chat, world, query) {
  const q = String(query || '').toLowerCase().trim();
  const matches = q ? (chat?.facts || []).filter((f) => f.text.toLowerCase().includes(q)) : chat?.facts || [];
  return matches.map((f) => ({ id: f.id, text: f.text, who: knownByNames(world, f) }));
}

export function deleteFact(chat, id) {
  if (chat?.facts) chat.facts = chat.facts.filter((f) => f.id !== id);
}

export function updateFact(chat, id, patch = {}) {
  const f = (chat?.facts || []).find((x) => x.id === id);
  if (!f) return null;
  if (typeof patch.text === 'string') f.text = patch.text.trim();
  if (typeof patch.everyone === 'boolean') f.everyone = patch.everyone;
  if (Array.isArray(patch.knownBy)) f.knownBy = [...new Set(patch.knownBy)];
  return f;
}

export function clearFacts(chat) {
  if (chat) chat.facts = [];
}

/**
 * Prune auto-extracted facts whose source message is no longer part of the
 * active story (regenerated away, edited, or deleted). Seed and manual facts
 * are always kept. `liveNodeIds` = the ids currently in the active path.
 */
export function pruneOrphanFacts(chat, liveNodeIds) {
  if (!chat?.facts) return { removed: 0 };
  const live = new Set(liveNodeIds || []);
  const before = chat.facts.length;
  chat.facts = chat.facts.filter((f) => f.origin === 'seed' || f.origin === 'manual' || live.has(f.origin));
  return { removed: before - chat.facts.length };
}

/**
 * Copy a world's canon into a new chat as seed facts. Worlds still provide
 * starting truths, but once seeded they belong to the chat — editable and
 * deletable without touching the world or any other chat.
 */
export function seedFromWorld(chat, world) {
  ensureFactStore(chat);
  for (const f of world?.facts || []) {
    addFact(chat, { text: f.text, knownBy: [...(f.knownBy || [])], everyone: !!f.everyone, origin: 'seed' });
  }
  return chat.facts;
}
