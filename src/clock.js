// clock.js — in-universe time, computed rather than guessed.
//
// The old design asked the utility model to report `elapsed_minutes` as JSON.
// That fails twice over: a roleplay finetune is bad at emitting JSON, and
// minutes cannot represent a single line of dialogue. So time is now measured
// directly from the text of the exchange:
//
//   • spoken dialogue advances at speaking pace (~150 words/minute)
//   • each action or description beat costs a few seconds
//   • handing off between speakers costs a beat of its own
//   • an explicit narrative cue ("three days later") overrides all of it
//
// It is deterministic, free, and cannot silently fail — the three things the
// LLM-driven version was not.

const WORDS_PER_SECOND = 2.5;      // ≈150 wpm, unhurried speech
const ACTION_BEAT_SECONDS = 3;     // a described action or beat of description
const SPEAKER_CHANGE_SECONDS = 1;  // the pause as attention moves
const COMBAT_ACTION_SECONDS = 1.5; // blows land faster than conversation moves

const MIN_SECONDS = 2;
const MAX_SECONDS = 60 * 60 * 24 * 30; // a month, for explicit skips

/* ── Explicit narrative time cues ─────────────────────────────────────────── */

const UNIT = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };

const WORD_NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  several: 3, few: 3, couple: 2, half: 0.5, many: 5,
};

// Fixed phrases that imply a jump, in seconds.
const PHRASES = [
  [/\b(?:the )?next morning\b/i, 12 * 3600],
  [/\b(?:the )?following morning\b/i, 12 * 3600],
  [/\bthe next day\b/i, 20 * 3600],
  [/\bthe following day\b/i, 20 * 3600],
  [/\bthat (?:same )?night\b/i, 8 * 3600],
  [/\bthat evening\b/i, 6 * 3600],
  [/\blater that day\b/i, 4 * 3600],
  [/\bby (?:dawn|sunrise|morning)\b/i, 10 * 3600],
  [/\bby (?:nightfall|sundown|evening)\b/i, 6 * 3600],
  [/\bovernight\b/i, 9 * 3600],
  [/\bmoments later\b/i, 30],
  [/\ba moment later\b/i, 20],
  [/\bseconds later\b/i, 10],
  [/\bshortly (?:after|afterwards?|later)\b/i, 300],
  [/\bsome time later\b/i, 3600],
  [/\bmuch later\b/i, 6 * 3600],
];

const numFrom = (raw) => {
  if (!raw) return 1;
  const t = String(raw).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return WORD_NUM[t] ?? 1;
};

/**
 * Look for an explicit statement that time passed. Returns seconds, or null.
 * Deliberately conservative: only fires on phrasing that clearly signals a skip.
 */
export function detectTimeSkip(text) {
  const s = String(text || '');
  if (!s) return null;

  // "three days later", "a few hours pass", "after two weeks"
  const quantified = new RegExp(
    String.raw`\b(?:after\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|several|few|couple|half|many)\s+` +
      String.raw`(second|minute|hour|day|week|month|year)s?\b` +
      String.raw`(?:\s+(?:later|pass|passes|passed|go by|goes by|went by|of\s+\w+))?`,
    'i'
  );
  const m = s.match(quantified);
  if (m) {
    const n = numFrom(m[1]);
    const unit = UNIT[m[2].toLowerCase()];
    if (unit) {
      const trailing = m[0].toLowerCase();
      const isSkip = /later|pass|passes|passed|go by|goes by|went by/.test(trailing) || /^after\s/.test(trailing);
      // A bare "two hours of surgery" still means time passed; a bare
      // "three seconds" mid-action usually doesn't. Require a skip marker
      // for anything under an hour.
      if (isSkip || unit >= 3600) return clamp(Math.round(n * unit), 1, MAX_SECONDS);
    }
  }

  for (const [re, secs] of PHRASES) if (re.test(s)) return secs;
  return null;
}

/* ── Content-based estimation ─────────────────────────────────────────────── */

const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const COMBAT = /\b(punch|punche[sd]|strike|strikes|struck|swing|swings|swung|slam|slams|slammed|dodge|dodges|dodged|block|blocks|blocked|hurl|hurls|hurled|lunge|lunges|lunged|kick|kicks|kicked|fires?|fired|blast|blasts|blasted|impact|crash|crashes|crashed|grapple|tackles?|tackled)\b/i;

// Pull out spoken lines. Handles straight and curly quotes.
function dialogueLines(text) {
  const out = [];
  const re = /[“"]([^”"]{1,600})[”"]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1]);
  return out;
}

/**
 * Estimate how much in-universe time an exchange consumed, in seconds.
 * An explicit narrative cue wins outright; otherwise it is measured from the
 * dialogue and action beats actually present in the text.
 */
export function estimateElapsedSeconds(text, opts = {}) {
  const s = String(text || '');
  if (!s.trim()) return 0;

  const skip = detectTimeSkip(s);
  if (skip != null) return skip;

  const lines = dialogueLines(s);
  let seconds = 0;

  for (const line of lines) seconds += wordCount(line) / WORDS_PER_SECOND;
  if (lines.length > 1) seconds += (lines.length - 1) * SPEAKER_CHANGE_SECONDS;

  // Everything that isn't dialogue is action or description.
  const prose = s.replace(/[“"][^”"]*[”"]/g, ' ');
  const beats = prose.split(/[.!?]+/).map((x) => x.trim()).filter((x) => wordCount(x) >= 3);
  const fighting = COMBAT.test(prose);
  seconds += beats.length * (fighting ? COMBAT_ACTION_SECONDS : ACTION_BEAT_SECONDS);

  const lo = opts.minSeconds ?? MIN_SECONDS;
  const hi = opts.maxSeconds ?? 900; // without an explicit cue, cap at 15 minutes
  return clamp(Math.round(seconds), lo, hi);
}

/* ── Display ──────────────────────────────────────────────────────────────── */

/** Elapsed time, phrased the way a person would say it. */
export function fmtElapsed(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  if (t < 60) return `${t}s`;
  if (t < 3600) {
    const m = Math.floor(t / 60);
    const s = t % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  if (t < 86400) {
    const h = Math.floor(t / 3600);
    const m = Math.round((t % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(t / 86400);
  const h = Math.round((t % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** A wall-clock reading for scenes that want one, from a start-of-day offset. */
export function fmtTimeOfDay(seconds, startSeconds = 0) {
  const t = Math.max(0, Math.round(Number(seconds) || 0)) + startSeconds;
  const day = Math.floor(t / 86400);
  const rem = t % 86400;
  const h = String(Math.floor(rem / 3600)).padStart(2, '0');
  const m = String(Math.floor((rem % 3600) / 60)).padStart(2, '0');
  return day > 0 ? `Day ${day + 1}, ${h}:${m}` : `${h}:${m}`;
}

/** Parse a player directive like "/wait 20m", "/wait 2h", "/wait 3 days". */
export function parseDuration(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'm')[0]; // bare numbers mean minutes
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[u] ?? 60;
  return clamp(Math.round(n * mult), 1, MAX_SECONDS);
}
