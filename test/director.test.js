import assert from 'node:assert';
import test from 'node:test';
import * as D from '../src/director.js';

// A tiny fake character database for name→id resolution.
const CAST = { superman: 'Superman', wonderwoman: 'Wonder Woman', hawkgirl: 'Hawkgirl', gl: 'Green Lantern (John)', superboy: 'Superboy', nightwing: 'Nightwing' };
const resolve = (name) => {
  const q = String(name).toLowerCase().trim();
  let hit = Object.entries(CAST).find(([, n]) => n.toLowerCase() === q);
  if (!hit) hit = Object.entries(CAST).find(([, n]) => n.toLowerCase().includes(q));
  return hit ? hit[0] : null;
};

test('newSceneState seeds present and zeroes the clock', () => {
  const s = D.newSceneState(['nightwing', 'superboy']);
  assert.equal(s.clock, 0);
  assert.deepEqual(s.present.sort(), ['nightwing', 'superboy']);
  assert.deepEqual(s.away, []);
  assert.deepEqual(s.pending, []);
});

test('ensureSceneState migrates a bare/old scene', () => {
  const s = D.ensureSceneState(undefined, ['nightwing']);
  assert.deepEqual(s.present, ['nightwing']);
  const s2 = D.ensureSceneState({ present: ['superman'] }, []);
  assert.equal(s2.clock, 0);
  assert.ok(Array.isArray(s2.pending));
});

test('fmtClock renders H:MM', () => {
  assert.equal(D.fmtClock(0), '0:00');
  assert.equal(D.fmtClock(5), '0:05');
  assert.equal(D.fmtClock(72), '1:12');
});

test('roster mutations are immutable and correct', () => {
  const s0 = D.newSceneState(['nightwing']);
  const s1 = D.addToScene(s0, 'superman');
  assert.deepEqual(s0.present, ['nightwing'], 'original untouched');
  assert.ok(s1.present.includes('superman'));
  const s2 = D.sendAway(s1, 'superman');
  assert.ok(!s2.present.includes('superman') && s2.away.includes('superman'));
  const s3 = D.bringBack(s2, 'superman');
  assert.ok(s3.present.includes('superman') && !s3.away.includes('superman'));
  const s4 = D.removeFromScene(s3, 'nightwing');
  assert.ok(!s4.present.includes('nightwing') && !s4.away.includes('nightwing'), 'removed = nearby, not away');
});

test('advanceClock adds minutes', () => {
  const s = D.advanceClock(D.newSceneState(), 5);
  assert.equal(s.clock, 5);
  assert.equal(D.advanceClock(s, 7).clock, 12);
});

test('schedule stores a time-gated event, sorted by time', () => {
  let s = D.newSceneState();
  s = D.schedule(s, { at: 10, text: 'later', enter: ['hawkgirl'] });
  s = D.schedule(s, { at: 5, text: 'sooner', enter: ['gl'] });
  assert.equal(s.pending.length, 2);
  assert.equal(s.pending[0].text, 'sooner', 'sorted by trigger time');
  assert.deepEqual(s.pending[0].enter, ['gl']);
});

test('fireDueEvents triggers only what is due, brings arrivals in, once', () => {
  let s = D.newSceneState(['nightwing']);
  s = D.schedule(s, { at: 5, text: 'League reinforcements arrive.', enter: ['hawkgirl', 'gl'] });
  // not yet due
  let r = D.fireDueEvents(s);
  assert.equal(r.fired.length, 0);
  assert.ok(!r.state.present.includes('hawkgirl'));
  // advance past the trigger, then fire
  s = D.advanceClock(s, 5);
  r = D.fireDueEvents(s);
  assert.equal(r.fired.length, 1, 'event fired');
  assert.ok(r.state.present.includes('hawkgirl') && r.state.present.includes('gl'), 'arrivals joined');
  assert.deepEqual(r.state.justNow, ['League reinforcements arrive.']);
  assert.equal(r.state.pending.length, 0, 'fired events are cleared');
  // firing again does nothing
  const r2 = D.fireDueEvents(r.state);
  assert.equal(r2.fired.length, 0);
});

test('applyDirection: entrances, exits, sent-away, elapsed time', () => {
  let s = D.newSceneState(['nightwing', 'superboy']);
  const dir = {
    elapsedMinutes: 3,
    entered: ['Superman'],
    left: ['Nightwing'],
    sentAway: ['Superboy'],
    returned: [],
    events: [{ inMinutes: 5, text: 'More League members arrive.', enter: ['Hawkgirl', 'Green Lantern (John)'] }],
  };
  s = D.applyDirection(s, dir, resolve);
  assert.equal(s.clock, 3, 'clock advanced');
  assert.ok(s.present.includes('superman'), 'Superman entered');
  assert.ok(!s.present.includes('nightwing'), 'Nightwing left the stage');
  assert.ok(s.away.includes('superboy'), 'Superboy sent away');
  assert.equal(s.pending.length, 1, 'future arrival scheduled');
  assert.equal(s.pending[0].at, 8, 'scheduled at clock + in_minutes');
});

test('applyDirection ignores names not in the database', () => {
  let s = D.newSceneState(['nightwing']);
  s = D.applyDirection(s, { entered: ['Some Rando', 'Superman'] }, resolve);
  assert.ok(s.present.includes('superman'));
  assert.equal(s.present.length, 2, 'unknown name dropped');
});

test('parseDirection tolerates clean, fenced, and messy JSON', () => {
  const clean = D.parseDirection('{"elapsed_minutes":2,"entered":["Superman"],"left":[],"sent_away":[],"returned":[],"events":[]}');
  assert.equal(clean.elapsedMinutes, 2);
  assert.deepEqual(clean.entered, ['Superman']);

  const fenced = D.parseDirection('```json\n{"elapsed_minutes":0,"entered":[],"events":[{"in_minutes":5,"text":"backup","enter":["Hawkgirl"]}]}\n```');
  assert.equal(fenced.events.length, 1);
  assert.equal(fenced.events[0].inMinutes, 5);
  assert.deepEqual(fenced.events[0].enter, ['Hawkgirl']);

  const prose = D.parseDirection('Sure! Here is the JSON: {"elapsed_minutes":1,"sent_away":["Superboy"]} hope that helps');
  assert.equal(prose.elapsedMinutes, 1);
  assert.deepEqual(prose.sentAway, ['Superboy']);

  assert.deepEqual(D.parseDirection('not json at all').entered, []);
  assert.equal(D.parseDirection('').elapsedMinutes, 0);
});

test('parseDirection clamps absurd numbers', () => {
  const d = D.parseDirection('{"elapsed_minutes":99999,"events":[{"in_minutes":-4,"text":"x"}]}');
  assert.equal(d.elapsedMinutes, 240);
  assert.equal(d.events[0].inMinutes, 0);
});

test('parseDirectorCommand recognizes directives', () => {
  assert.deepEqual(D.parseDirectorCommand('/wait 5'), { type: 'wait', minutes: 5 });
  assert.deepEqual(D.parseDirectorCommand('/wait 1h'), { type: 'wait', minutes: 60 });
  assert.deepEqual(D.parseDirectorCommand('/enter Superman, Wonder Woman'), { type: 'enter', names: ['Superman', 'Wonder Woman'] });
  assert.deepEqual(D.parseDirectorCommand('/away Superboy'), { type: 'away', names: ['Superboy'] });
  assert.deepEqual(D.parseDirectorCommand('/back Superboy'), { type: 'back', names: ['Superboy'] });
  assert.deepEqual(D.parseDirectorCommand('/time'), { type: 'time' });
  assert.deepEqual(D.parseDirectorCommand('/scene'), { type: 'scene' });

  const sch = D.parseDirectorCommand('/schedule 5 Reinforcements arrive: Hawkgirl, Green Lantern');
  assert.equal(sch.type, 'schedule');
  assert.equal(sch.minutes, 5);
  assert.equal(sch.text, 'Reinforcements arrive');
  assert.deepEqual(sch.names, ['Hawkgirl', 'Green Lantern']);

  assert.equal(D.parseDirectorCommand('just some text'), null);
  assert.equal(D.parseDirectorCommand('/unknown thing'), null);
});

test('buildDirectorMessages names the roster and demands JSON', () => {
  const msgs = D.buildDirectorMessages({ exchangeText: 'stuff happened', roster: ['Superman', 'Hawkgirl'], present: ['Superman'], away: [], clock: 12 });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /scene director/i);
  assert.match(msgs[0].content, /Superman, Hawkgirl/);
  assert.match(msgs[0].content, /JSON/);
  assert.match(msgs[0].content, /0:12/); // clock formatted
  assert.match(msgs[1].content, /stuff happened/);
});

test('full loop: direction → apply → wait → fire brings arrivals in', () => {
  let s = D.newSceneState(['nightwing']);
  // a hero is hurt and carried off; reinforcements are triggered for +5 min
  s = D.applyDirection(
    s,
    { elapsedMinutes: 1, sentAway: ['Superboy'], events: [{ inMinutes: 5, text: 'Hawkgirl and a Lantern arrive.', enter: ['Hawkgirl', 'Green Lantern (John)'] }] },
    resolve
  );
  assert.ok(s.away.includes('superboy'));
  // treatment is "delayed" — five more minutes pass
  s = D.advanceClock(s, 5);
  const { state, fired } = D.fireDueEvents(s);
  assert.equal(fired.length, 1);
  assert.ok(state.present.includes('hawkgirl') && state.present.includes('gl'), 'the reinforcements arrived because time passed');
});
