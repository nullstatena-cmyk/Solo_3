/**
 * room.js — the room block.
 *
 * Character cards are excellent and they sit ~3,000 tokens above the generation
 * point, buried under every other card in the scene. By the time the model writes,
 * "clips the prefix off words" and "never uses contractions" are far away and
 * diffuse, and what survives is whatever is nearest. That's why mannerisms decay,
 * why pronouns drift, and why an unattributed line reads as narration.
 *
 * So the cards stay where they are, and a compact restatement goes at the bottom:
 * one line per present character, ~40 tokens each instead of ~600. Everything on
 * that line is chosen because it fails when it's far away —
 *
 *   pronoun   the drift fix; costs two characters
 *   staging   where they physically are, so "who was closest" has an answer
 *   bond      how they feel about the persona *right now*, so the model doesn't
 *             fall back on the most statistically common read of the exchange
 *   voice     eight words of mannerism, close enough to the generation point to fire
 *
 * Degrades gracefully: with no staging or bond set, the line still carries pronoun
 * and voice, which alone fixes drift and mannerism decay.
 */

const MAX_VOICE_WORDS = 14;

/** Fall back to the head of the personality text when no voice tag is set. */
function voiceTag(c) {
  const explicit = String(c.voice || '').trim();
  if (explicit) return explicit;
  const source = String(c.personality || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const words = source.split(' ');
  if (words.length <= MAX_VOICE_WORDS) return source;
  return `${words.slice(0, MAX_VOICE_WORDS).join(' ')}…`;
}

function pronounOf(c) {
  const p = String(c.pronoun || '').trim();
  return p || 'they';
}

/** Close a segment with a full stop, unless it already ends in one. */
function sentence(text) {
  const t = String(text).trim().replace(/[,;:\s]+$/, '');
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * @param {object[]} presentCast  resolved cast objects, in speaking order
 * @param {object|null} persona   the author's character
 * @param {object|null} scene     sceneState; `staging` and `bonds` are id-keyed maps
 * @returns {{role:'system', content:string}|null}
 */
export function buildRoomBlock({ presentCast = [], persona = null, scene = null } = {}) {
  const cast = (presentCast || []).filter(Boolean);
  if (!cast.length && !persona?.name) return null;

  const staging = (scene && scene.staging) || {};
  const bonds = (scene && scene.bonds) || {};
  const lines = [];

  if (persona?.name) {
    const pp = pronounOf(persona);
    lines.push(
      `${persona.name} (${pp}) — the author's character. Never write ${pp === 'they' ? 'their' : pp === 'he' ? 'his' : 'her'} ` +
        `dialogue, thoughts, or choices.`
    );
  }

  for (const c of cast) {
    const head = `${c.name} (${pronounOf(c)})`;
    const rest = [];
    const where = String(staging[c.id] || '').trim();
    if (where) rest.push(sentence(where));
    const bond = String(bonds[c.id] || '').trim();
    if (bond) rest.push(sentence(persona?.name ? `→ ${persona.name}: ${bond}` : `→ ${bond}`));
    const voice = voiceTag(c);
    if (voice) rest.push(sentence(`Voice: ${voice}`));
    lines.push(rest.length ? `${head} — ${rest.join(' ')}` : head);
  }

  // Fires from data, not from remembering to write it. If anyone in the room is
  // flagged as a minor the guard is emitted in the strongest slot in the prompt,
  // every single turn.
  const minors = [...cast, ...(persona?.name ? [persona] : [])].filter((c) => c.minor);
  if (minors.length) {
    const who = minors.length === cast.length + (persona?.name ? 1 : 0)
      ? 'Everyone present is a minor'
      : `${minors.map((c) => c.name).join(', ')} ${minors.length === 1 ? 'is a minor' : 'are minors'}`;
    lines.push(
      `\n${who}. Write no romantic or sexual content involving them, and no ` +
        `flirtation, attraction, or physical intimacy framed as romantic. ` +
        `Warmth, loyalty, rivalry and protectiveness are all available instead.`
    );
  }

  return {
    role: 'system',
    content: `[PRESENT — staging for the reply you are about to write]\n${lines.join('\n')}`,
  };
}

/** Merge director-reported staging (name-keyed) into id-keyed scene state. */
export function applyStaging(scene, reported = {}, resolve = () => null) {
  const next = { ...(scene || {}) };
  next.staging = { ...(next.staging || {}) };
  for (const [name, where] of Object.entries(reported || {})) {
    const id = resolve(name);
    const text = String(where || '').trim();
    if (!id) continue;
    if (text) next.staging[id] = text;
    else delete next.staging[id];
  }
  return next;
}

/** Set or clear one character's bond line toward the persona. */
export function setBond(scene, castId, text) {
  const next = { ...(scene || {}) };
  next.bonds = { ...(next.bonds || {}) };
  const clean = String(text || '').trim();
  if (clean) next.bonds[castId] = clean;
  else delete next.bonds[castId];
  return next;
}
