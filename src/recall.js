/**
 * recall.js — verbatim retrieval over the scene's own transcript.
 *
 * The tree already stores every turn verbatim; `summarizedIds` only marks a node
 * as folded *out of the prompt*, and never deletes its text. So the archive has
 * been there all along. What was missing is a way to get specific old turns back
 * without paying for all of them.
 *
 * A rolling summary is lossy by construction — it decides once, early, which
 * details mattered, and the details it drops are gone for good. Retrieval defers
 * that decision to the moment a detail is actually relevant, and returns the
 * original words rather than a paraphrase of them.
 *
 * Scoring is BM25, which is the right tool here for unglamorous reasons: it runs
 * client-side with no embedding service, it saturates term frequency (a turn that
 * says "Amazo" nine times isn't nine times more relevant), and it normalizes for
 * length (a long turn doesn't win just by being long). Two adjustments on top:
 * an exact-phrase bonus, because proper nouns and quoted lines are usually what
 * you're reaching for, and a mild recency tilt to break ties toward the near past.
 */

const STOP = new Set(
  ('a an and are as at be been but by for from had has have he her hers him his i if in is it its ' +
   'me my no not of on or our out she so than that the their them then there these they this to too ' +
   'up was we were what when which who will with you your').split(' ')
);

/** Words worth indexing: lowercase, 2+ chars, not a stopword. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

const K1 = 1.5;
const B = 0.75;

/**
 * Rank documents against a query with BM25.
 * @param {{id:string, text:string}[]} docs
 * @param {string} query
 * @returns {{id:string, score:number}[]} sorted best-first, zero-scoring dropped
 */
export function rank(docs, query) {
  const corpus = (docs || []).map((d) => ({ ...d, terms: tokenize(d.text) }));
  if (!corpus.length) return [];

  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];

  const N = corpus.length;
  const avgLen = corpus.reduce((s, d) => s + d.terms.length, 0) / N || 1;

  const df = new Map();
  for (const d of corpus) {
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  }

  // Phrases worth a bonus: quoted spans, plus capitalised runs from the query.
  const phrases = [
    ...String(query).matchAll(/"([^"]{3,60})"/g),
    ...String(query).matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g),
  ].map((m) => m[1].toLowerCase());

  const scored = corpus.map((d, i) => {
    const len = d.terms.length || 1;
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLen)));
    }

    if (score > 0) {
      const hay = d.text.toLowerCase();
      for (const p of phrases) if (p && hay.includes(p)) score += 1.5;
      // Mild tilt toward the near past; never enough to outrank a real match.
      score *= 1 + (i / N) * 0.15;
    }

    return { id: d.id, score };
  });

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

const estTokens = (s) => Math.ceil(String(s || '').length / 4);

/**
 * Choose folded turns to reinstate verbatim.
 *
 * @param {{id:string, role:string, content:string, speaker?:string}[]} folded
 *        candidate turns, chronological
 * @param {string} query        usually the recent window plus who's present
 * @param {number} maxTokens    budget for the whole block
 * @param {number} topK         hard cap on how many turns come back
 * @returns {{id:string, role:string, content:string, speaker?:string}[]} chronological
 */
export function selectRecall(folded = [], query = '', { maxTokens = 900, topK = 6 } = {}) {
  const docs = folded.map((n) => ({ id: n.id, text: n.content }));
  const ranked = rank(docs, query).slice(0, topK);
  if (!ranked.length) return [];

  const byId = new Map(folded.map((n) => [n.id, n]));
  const order = new Map(folded.map((n, i) => [n.id, i]));

  const picked = [];
  let used = 0;
  for (const r of ranked) {
    const node = byId.get(r.id);
    if (!node) continue;
    const cost = estTokens(node.content) + 8;
    if (used + cost > maxTokens) continue; // skip, don't stop — a short later hit may still fit
    picked.push(node);
    used += cost;
  }

  return picked.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/**
 * Render chosen turns as a prompt block. Labelled as earlier material and marked
 * non-chronological, so the model doesn't read it as the immediately preceding
 * beat and continue from the wrong place.
 */
export function buildRecallBlock(turns = [], { personaName = '' } = {}) {
  if (!turns.length) return null;
  const body = turns
    .map((n) => {
      const who = n.speaker || (n.role === 'user' ? personaName || 'The author' : 'Narration');
      return `${who}: ${String(n.content).trim()}`;
    })
    .join('\n\n');

  return {
    role: 'system',
    content:
      `[EARLIER IN THIS SCENE — verbatim, out of order, for reference only]\n` +
      `These are exact excerpts from turns that have already happened, retrieved because they ` +
      `bear on the current moment. They are not the most recent events and the scene does not ` +
      `resume from them.\n\n${body}`,
  };
}
