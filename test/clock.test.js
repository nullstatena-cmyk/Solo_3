import assert from 'node:assert';
import test from 'node:test';
import * as C from '../src/clock.js';

test('a single short line of dialogue takes a few seconds', () => {
  const t = C.estimateElapsedSeconds('"Who are you and why are you in our headquarters?"');
  assert.ok(t >= 2 && t <= 12, `expected a handful of seconds, got ${t}`);
});

test('ten characters talking over each other takes far longer than one', () => {
  const one = C.estimateElapsedSeconds('"He\'s got heart, I\'ll give him that."');
  const many = C.estimateElapsedSeconds(
    ['"He\'s got heart, I\'ll give him that."',
     '"Dude, that\'s like, next level stuff."',
     '"He\'s got more guts than most of us."',
     '"That\'s true heroism, he put himself in harm\'s way."',
     '"If only we had done things differently."',
     '"Why did we make it worse?"',
     '"He\'s got a warrior\'s spirit."',
     '"I\'m not a hero. They are."',
     '"That kid\'s got heart, and he\'s got guts."',
     '"This changes things."'].join(' ')
  );
  assert.ok(many > one * 5, `ten lines (${many}s) should dwarf one (${one}s)`);
  assert.ok(many >= 20 && many <= 90, `expected roughly half a minute, got ${many}s`);
});

test('action beats add time on top of dialogue', () => {
  const bare = C.estimateElapsedSeconds('"Stand down."');
  const staged = C.estimateElapsedSeconds(
    'Aqualad steps between them and raises a hand. The water-bearers hum awake. "Stand down." He does not blink.'
  );
  assert.ok(staged > bare, 'staging costs time');
});

test('a fight resolves faster per beat than a conversation', () => {
  const fight = C.estimateElapsedSeconds(
    'Amazo swings and Superboy blocks. The slab crashes into the asphalt. Robin dodges left and fires a line. Wonder Girl slams into its back.'
  );
  const talk = C.estimateElapsedSeconds(
    'Aqualad considers the question. He looks at the readouts for a long moment. He turns toward the door. He waits for an answer.'
  );
  assert.ok(fight < talk, `combat beats should be quicker (${fight}s vs ${talk}s)`);
});

test('explicit cues override the estimate', () => {
  assert.equal(C.detectTimeSkip('Three days later, the Watchtower briefing convened.'), 3 * 86400);
  assert.equal(C.detectTimeSkip('Two hours pass.'), 2 * 3600);
  assert.equal(C.detectTimeSkip('The next morning, he woke in the medical bay.'), 12 * 3600);
  assert.equal(C.detectTimeSkip('Moments later, the door opened.'), 30);
  assert.equal(C.detectTimeSkip('After a week of silence, she called.'), 604800);
  assert.equal(C.detectTimeSkip('He said nothing at all.'), null);

  const skipped = C.estimateElapsedSeconds('"See you then." Three days later, the Watchtower briefing convened.');
  assert.equal(skipped, 3 * 86400, 'the cue wins over the content estimate');
});

test('a bare short duration mid-action is not treated as a skip', () => {
  assert.equal(C.detectTimeSkip('He had three seconds to decide.'), null);
  assert.equal(C.detectTimeSkip('It took two hours of surgery.'), 2 * 3600, 'hour-scale still counts');
});

test('estimates are clamped to something sane', () => {
  assert.equal(C.estimateElapsedSeconds(''), 0);
  assert.ok(C.estimateElapsedSeconds('Hm.') >= 2, 'never zero for real content');
  const huge = C.estimateElapsedSeconds('"word ".repeat'.padEnd(20000, 'word '));
  assert.ok(huge <= 900, 'content alone never exceeds fifteen minutes');
});

test('fmtElapsed reads the way a person would say it', () => {
  assert.equal(C.fmtElapsed(0), '0s');
  assert.equal(C.fmtElapsed(45), '45s');
  assert.equal(C.fmtElapsed(60), '1m');
  assert.equal(C.fmtElapsed(200), '3m 20s');
  assert.equal(C.fmtElapsed(3600), '1h');
  assert.equal(C.fmtElapsed(4440), '1h 14m');
  assert.equal(C.fmtElapsed(86400), '1d');
  assert.equal(C.fmtElapsed(180000), '2d 2h');
});

test('fmtTimeOfDay gives a wall clock and rolls into days', () => {
  assert.equal(C.fmtTimeOfDay(0, 20 * 3600), '20:00');
  assert.equal(C.fmtTimeOfDay(3600, 20 * 3600), '21:00');
  assert.equal(C.fmtTimeOfDay(6 * 3600, 20 * 3600), 'Day 2, 02:00');
});

test('parseDuration understands player shorthand', () => {
  assert.equal(C.parseDuration('30s'), 30);
  assert.equal(C.parseDuration('5'), 300, 'bare numbers are minutes');
  assert.equal(C.parseDuration('20m'), 1200);
  assert.equal(C.parseDuration('2h'), 7200);
  assert.equal(C.parseDuration('3 days'), 3 * 86400);
  assert.equal(C.parseDuration('1 week'), 604800);
  assert.equal(C.parseDuration('nonsense'), null);
});
