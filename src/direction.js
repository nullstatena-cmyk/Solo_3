/**
 * Authorial direction — the second channel in a user turn.
 *
 * A message like
 *
 *   Move. He shoves Artemis clear. [The others don't reach her in time.]
 *
 * carries two registers at once. "Move." is the persona speaking — something the
 * story may resist, and an RP finetune is trained to treat the whole user turn as
 * a *proposal* from the persona. The bracketed clause is the author declaring what
 * happened, which the story may not resist. Sent as one lump, the declaration gets
 * negotiated with: the model has someone catch the blow, or softens it.
 *
 * So the two are split. Bracketed spans come out of the user turn and are
 * re-injected as a system message in the last prompt position — the same slot that
 * made the author's note work — where they read as established narration rather
 * than an attempt.
 *
 * Parsing happens at prompt-assembly time, not at send time. The node keeps the
 * author's raw text, so regenerate, branch and edit all carry the direction with
 * them, and the composer shows what was actually typed.
 *
 * Pure and deterministic, like the rest of prompt building.
 */

/**
 * Collapse the whitespace left behind when a span is lifted out, without
 * flattening intentional paragraph breaks.
 */
function tidy(text) {
  return String(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Scan a raw user message once and return every form of it we need.
 *
 * Rules:
 *  - `[...]` is a direction.
 *  - Nesting is kept whole: `[a [b] c]` is one direction, "a [b] c".
 *  - `\[` and `\]` are literal brackets and never parsed.
 *  - An unclosed `[` is left verbatim — losing the author's sentence to a typo is
 *    far worse than missing a direction.
 *  - A stray `]` is left verbatim.
 *  - Empty or whitespace-only spans are dropped.
 *
 * @param {string} raw
 * @returns {{ spoken: string, inlined: string, directions: string[] }}
 *   spoken     — directions lifted out entirely (for the turn being answered)
 *   inlined    — brackets removed, text kept in place (for turns already played)
 *   directions — the lifted spans, in order
 */
export function splitDirection(raw = '') {
  const text = String(raw ?? '');
  const directions = [];
  let spoken = '';
  let inlined = '';
  let buf = '';
  let depth = 0;
  let openIndex = -1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '\\' && (next === '[' || next === ']')) {
      if (depth > 0) buf += next;
      else spoken += next;
      inlined += next;
      i += 2;
      continue;
    }

    if (ch === '[') {
      if (depth === 0) { openIndex = i; buf = ''; }
      else { buf += ch; inlined += ch; }
      depth++;
      i++;
      continue;
    }

    if (ch === ']') {
      if (depth === 0) {
        spoken += ch;
        inlined += ch;
      } else {
        depth--;
        if (depth === 0) {
          const d = buf.trim();
          if (d) directions.push(d);
          buf = '';
          openIndex = -1;
        } else {
          buf += ch;
          inlined += ch;
        }
      }
      i++;
      continue;
    }

    if (depth > 0) buf += ch;
    else spoken += ch;
    inlined += ch;
    i++;
  }

  // Unclosed bracket: restore the tail verbatim in both forms.
  if (depth > 0 && openIndex >= 0) {
    spoken += text.slice(openIndex);
  }

  return { spoken: tidy(spoken), inlined: tidy(inlined), directions };
}

/** True if the text contains at least one parseable direction. */
export function hasDirection(raw = '') {
  return splitDirection(raw).directions.length > 0;
}

/**
 * The binding system message for this turn's directions, or null if there are
 * none.
 *
 * Phrased as a format spec with an explicit opening slot. "Begin your reply by
 * narrating it" gives the model a slot to fill, which lands far better than an
 * instruction to obey — the same reason naming the beats fixed the flow.
 *
 * @param {string[]} directions
 * @returns {{role: 'system', content: string}|null}
 */
export function buildDirectionMessage(directions = []) {
  const list = (Array.isArray(directions) ? directions : [directions])
    .map((d) => String(d || '').trim())
    .filter(Boolean);
  if (!list.length) return null;

  const body = list.map((d) => `• ${d}`).join('\n');

  return {
    role: 'system',
    content:
      `[Authorial direction — binding for the reply you are about to write, and outranking everything above]\n` +
      `The following is established fact, not something a character is attempting:\n\n` +
      `${body}\n\n` +
      `It has already happened. Do not prevent it, soften it, delay it, reverse it, ` +
      `or reinterpret it, and do not let any character succeed at stopping it. ` +
      `Begin your reply by narrating it as accomplished fact, then continue the scene from there.`,
  };
}
