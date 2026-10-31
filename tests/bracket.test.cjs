const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script id="bracket-engine">([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({});
vm.runInContext(source + '\nglobalThis.engine = BracketEngine;', context);
const engine = context.engine;
const doubleSource = html.match(/<script id="double-engine">([\s\S]*?)<\/script>/)[1];
vm.runInContext(doubleSource + '\nglobalThis.doubleEngine = DoubleEngine;', context);
const doubleEngine = context.doubleEngine;
const makeState = count => ({ teams: Array.from({ length: count }, (_, i) => `Team ${i + 1}`), picks: engine.blankPicks(count) });

test('every team appears once, byes are spread out, and there are exactly n - 1 playable matches', () => {
  for (const count of [...Array.from({ length: 256 }, (_, i) => i + 2), 511, 512, 513, 1000, 1024, 1025, 4097]) {
    const bracket = engine.createBracket(count);
    const entrants = Array.from(bracket.slots).filter(Number.isInteger);
    assert.deepEqual(entrants, Array.from({ length: count }, (_, i) => i));
    assert.equal(bracket.slots.filter(v => v === null).length, bracket.byes);
    assert.equal(bracket.sizes.reduce((a, b) => a + b, 0) - bracket.byes, count - 1);
    const state = makeState(count);
    assert.equal(engine.countPicks(state), 0);
    for (let m = 0; m < bracket.sizes[0]; m++) {
      assert.ok(Number.isInteger(bracket.slots[m * 2]));
      if (!engine.isPlayable(bracket, 0, m)) assert.equal(state.picks[0][m], bracket.slots[m * 2]);
    }
  }
});

test('all bracket sizes can be completed and round-tripped without counting byes as picks', () => {
  for (const count of [...Array.from({ length: 128 }, (_, i) => i + 2), 257, 1000]) {
    const bracket = engine.createBracket(count);
    let state = makeState(count);
    for (let r = 0; r < bracket.sizes.length; r++) {
      for (let m = 0; m < bracket.sizes[r]; m++) {
        if (!engine.isPlayable(bracket, r, m)) continue;
        const entrants = engine.getEntrants(bracket, state.picks, r, m);
        assert.ok(entrants.every(Number.isInteger));
        state = engine.chooseWinner(state, r, m, entrants[(r + m) % 2]);
      }
    }
    assert.equal(engine.countPicks(state), count - 1);
    assert.ok(Number.isInteger(state.picks.at(-1)[0]));
    assert.equal(JSON.stringify(engine.normalizeState(JSON.parse(JSON.stringify(state)))), JSON.stringify(state));
  }
});

test('changing an early winner clears only its downstream path, keeping unrelated picks and byes', () => {
  const bracket = engine.createBracket(5);
  let state = makeState(5);
  for (let r = 0; r < bracket.sizes.length; r++) {
    for (let m = 0; m < bracket.sizes[r]; m++) {
      if (engine.isPlayable(bracket, r, m)) state = engine.chooseWinner(state, r, m, engine.getEntrants(bracket, state.picks, r, m)[0]);
    }
  }
  const match = state.picks[0].findIndex((_, m) => engine.isPlayable(bracket, 0, m));
  const next = engine.chooseWinner(state, 0, match, bracket.slots[match * 2 + 1]);
  for (let r = 1; r < bracket.sizes.length; r++) {
    const changed = Math.floor(match / (2 ** r));
    assert.equal(next.picks[r][changed], null);
    next.picks[r].forEach((pick, m) => { if (m !== changed) assert.equal(pick, state.picks[r][m]); });
  }
  state.picks[0].forEach((pick, m) => { if (m !== match) assert.equal(next.picks[0][m], pick); });
  assert.equal(engine.chooseWinner(next, 0, match, 999), next);
  const bye = state.picks[0].findIndex((_, m) => !engine.isPlayable(bracket, 0, m));
  assert.equal(engine.chooseWinner(state, 0, bye, bracket.slots[bye * 2]), state);
});

test('old 64-team saves retain their order and picks', () => {
  const legacy = { teams: makeState(64).teams, picks: [32, 16, 8, 4, 2, 1].map(n => Array(n).fill(null)) };
  legacy.picks[0][0] = 1;
  legacy.picks[0][1] = 2;
  legacy.picks[1][0] = 2;
  assert.equal(JSON.stringify(engine.normalizeState(legacy)), JSON.stringify(legacy));
});

test('imports reject malformed teams and shapes and repair invalid picks and bye winners', () => {
  for (const bad of [null, {}, { teams: ['One'], picks: [] }, { teams: ['One', ' one '], picks: [[null]] }, { teams: ['One', ''], picks: [[null]] }, { teams: ['One', 'Two'], picks: [[null, null]] }]) {
    assert.equal(engine.normalizeState(bad), null);
  }
  const state = makeState(3);
  state.picks[0] = [999, null];
  state.picks[1][0] = 999;
  const repaired = engine.normalizeState(state);
  assert.equal(repaired.picks[0][0], null);
  assert.equal(repaired.picks[0][1], 2);
  assert.equal(repaired.picks[1][0], null);
});

// Run the actual page scripts with DOM/storage adapters to check event wiring and
// rendering output without requiring a browser installation or dependencies.
function loadApp(saved = {}, width = 1200) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set('#' + id, {
      value: '', textContent: '', innerHTML: '', hidden: false, style: {}, attributes: {}, handlers: {}, files: [],
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, fn) { this.handlers[event] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; },
      click() { return this.handlers.click?.({ target: this }); },
      remove() {},
    });
  }
  const storage = new Map(Object.entries(saved));
  const documentHandlers = {};
  let exported;
  let link;
  let confirmed = true;
  const context = vm.createContext({
    document: {
      querySelector: selector => elements.get(selector),
      addEventListener: (event, fn) => { documentHandlers[event] = fn; },
      createElement: () => (link = { click() {}, remove() {} }),
      body: { appendChild() {} },
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { innerWidth: width, confirm: () => confirmed },
    Blob, URL: { createObjectURL: blob => { exported = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: () => 1, clearTimeout() {},
  });
  for (const [, script] of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(script, context);
  const el = id => elements.get('#' + id);
  const pick = (round, match, team) => {
    const button = { disabled: false, dataset: { round, match, team } };
    documentHandlers.click({ target: { closest: selector => selector === '.team-option' ? button : null } });
  };
  const resize = count => {
    el('editBtn').click();
    el('teamCountInput').value = String(count);
    el('resizeTeamsBtn').click();
    el('saveTeamsBtn').click();
  };
  const pickDouble = (key, team) => {
    const button = { disabled: false, dataset: { key, team } };
    documentHandlers.click({ target: { closest: selector => selector === '.team-option' ? button : null } });
  };
  const format = elimination => { el('formatSelect').value = elimination; el('formatSelect').handlers.change(); };
  return { el, storage, pick, pickDouble, format, resize, setConfirmation: value => { confirmed = value; }, exported: () => ({ blob: exported, link }) };
}

test('page editor resizes, rejects invalid lists, handles canceled resets, and preserves renames', () => {
  const app = loadApp();
  assert.equal(app.el('picksCount').textContent, '0 / 63');
  app.resize(5);
  assert.equal(app.el('teamCount').textContent, 5);
  assert.equal(app.el('picksCount').textContent, '0 / 4');
  assert.equal((app.el('bracketCanvas').innerHTML.match(/Bye: advances/g) || []).length, 3);
  app.pick(0, 0, 0);
  app.pick(1, 0, 0);
  app.pick(1, 1, 3);
  app.pick(2, 0, 3);
  assert.equal(app.el('picksCount').textContent, '4 / 4');
  assert.equal(app.el('championSummary').textContent, 'Team 04');
  assert.equal(app.el('progressBar').attributes['aria-valuemax'], '4');
  app.setConfirmation(false);
  app.resize(2);
  assert.equal(app.el('teamCount').textContent, 5);
  app.setConfirmation(true);
  app.el('cancelDialogBtn').click();
  app.el('editBtn').click();
  app.el('teamNames').value = 'Alpha\nBeta\nGamma\nDelta\nEpsilon';
  app.el('saveTeamsBtn').click();
  assert.equal(app.el('championSummary').textContent, 'Delta');
  assert.equal(app.el('picksCount').textContent, '4 / 4');
  app.el('resetBtn').click();
  assert.equal(app.el('picksCount').textContent, '0 / 4');
  assert.equal((app.el('bracketCanvas').innerHTML.match(/Bye: advances/g) || []).length, 3);
  app.el('editBtn').click();
  app.el('teamNames').value = 'Only one';
  app.el('saveTeamsBtn').click();
  assert.equal(app.el('editorError').textContent, 'Enter at least two teams.');
  app.el('teamNames').value = 'Same\nsame';
  app.el('saveTeamsBtn').click();
  assert.equal(app.el('editorError').textContent, 'Each team name must be unique.');
  app.el('teamCountInput').value = '2.5';
  app.el('resizeTeamsBtn').click();
  assert.match(app.el('editorError').textContent, /whole number/);
  app.el('cancelDialogBtn').click();
  app.resize(2);
  assert.equal(app.el('picksCount').textContent, '0 / 1');
  assert.match(app.el('bracketHeadings').innerHTML, /Final/);
  app.pick(0, 0, 1);
  assert.equal(app.el('championSummary').textContent, 'Beta');
  app.resize(1000);
  assert.equal(app.el('teamCount').textContent, 1000);
  assert.equal(app.el('fullView').hidden, true);
  assert.equal(app.el('picksCount').textContent, '0 / 999');
});

test('page loads old saves, persists new counts, and imports and exports variable-size brackets', async () => {
  const legacy = makeState(64);
  legacy.picks[0][0] = 1;
  const app = loadApp({ 'bracket-studio-64-v1': JSON.stringify(legacy) }, 390);
  assert.equal(app.el('picksCount').textContent, '1 / 63');
  app.resize(3);
  app.pick(0, 0, 1);
  assert.equal(app.el('compactTitle').textContent, 'Final');
  app.pick(1, 0, 2);
  assert.equal(app.el('compactTitle').textContent, 'Champion');
  app.el('exportBtn').click();
  const { blob, link } = app.exported();
  assert.equal(link.download, 'my-3-team-bracket.json');
  const exported = await blob.text();
  assert.equal(JSON.parse(exported).version, 3);
  const restored = loadApp(Object.fromEntries(app.storage), 390);
  assert.equal(restored.el('picksCount').textContent, '2 / 2');
  assert.equal(restored.el('championSummary').textContent, 'Team 3');
  restored.resize(2);
  const input = restored.el('importInput');
  input.files = [{ text: async () => exported }];
  await input.handlers.change({ target: input });
  assert.equal(restored.el('picksCount').textContent, '2 / 2');
  assert.equal(restored.el('teamCount').textContent, 3);
  restored.el('shuffleBtn').click();
  assert.equal(restored.el('picksCount').textContent, '0 / 2');
  input.files = [{ text: async () => JSON.stringify(legacy) }];
  await input.handlers.change({ target: input });
  assert.equal(restored.el('picksCount').textContent, '1 / 63');
});

function finishDouble(count, reset, seed = 0) {
  let state = doubleEngine.createState(makeState(count).teams);
  const losses = Array(count).fill(0);
  let played = 0;
  while (true) {
    const evaluated = doubleEngine.evaluate(state);
    if (evaluated.champion !== null) {
      assert.equal(played, 2 * count - 2 + Number(reset));
      assert.equal(evaluated.count, played);
      assert.equal(evaluated.total, played);
      losses.forEach((loss, team) => assert.equal(loss, team === evaluated.champion ? Number(reset) : 2));
      return state;
    }
    const match = [...evaluated.results.values()].find(n => n.playable && n.winner === undefined);
    assert.ok(match, `A playable match must remain for ${count} teams`);
    const [a, b] = match.entrants;
    assert.notEqual(a, b);
    assert.ok(losses[a] < 2 && losses[b] < 2, 'Eliminated teams cannot return');
    if (match.bucket === 'picks') assert.deepEqual([losses[a], losses[b]], [0, 0]);
    if (match.bucket === 'loserPicks' || match.reset) assert.deepEqual([losses[a], losses[b]], [1, 1]);
    if (match.key === 'F1') assert.deepEqual([losses[a], losses[b]], [0, 1]);
    const winnerIndex = match.key === 'F1' ? Number(reset) : ((played + seed * 13 + Math.floor(played / 3)) % 2);
    losses[match.entrants[1 - winnerIndex]]++;
    state = doubleEngine.chooseWinner(state, match.key, match.entrants[winnerIndex]);
    assert.ok(++played <= 2 * count - 1);
  }
}

test('double elimination gives every non-champion exactly two losses, with and without a final reset', () => {
  for (let count = 2; count <= 65; count++) {
    for (const reset of [false, true]) {
      for (let seed = 0; seed < 2; seed++) finishDouble(count, reset, seed);
    }
  }
});

test('every possible result sequence for two through five teams ends with a valid double-elimination champion', () => {
  for (let count = 2; count <= 5; count++) {
    let outcomes = 0;
    function visit(state, losses, played) {
      const evaluated = doubleEngine.evaluate(state);
      if (evaluated.champion !== null) {
        losses.forEach((loss, team) => assert.equal(loss, team === evaluated.champion ? Number(evaluated.resetRequired) : 2));
        assert.equal(played, evaluated.total);
        outcomes++;
        return;
      }
      const match = [...evaluated.results.values()].find(n => n.playable && n.winner === undefined);
      assert.ok(match);
      for (let winner = 0; winner < 2; winner++) {
        const nextLosses = losses.slice();
        assert.ok(match.entrants.every(team => nextLosses[team] < 2));
        nextLosses[match.entrants[1 - winner]]++;
        visit(doubleEngine.chooseWinner(state, match.key, match.entrants[winner]), nextLosses, played + 1);
      }
    }
    visit(doubleEngine.createState(makeState(count).teams), Array(count).fill(0), 0);
    assert.equal(outcomes, 3 * (2 ** (2 * count - 3)));
  }
});

test('large double brackets preserve unique entries, byes, and valid match dependencies', () => {
  for (const count of [127, 128, 129, 257, 1000, 4097]) {
    const state = doubleEngine.createState(makeState(count).teams);
    const evaluated = doubleEngine.evaluate(state);
    assert.equal(evaluated.count, 0);
    assert.equal(evaluated.total, 2 * count - 2);
    assert.equal(evaluated.champion, null);
    const known = new Set();
    for (const node of evaluated.bracket.nodes) {
      assert.ok(!known.has(node.key));
      for (const source of node.sources) if (source.key) assert.ok(known.has(source.key));
      known.add(node.key);
    }
  }
  finishDouble(257, true);
});

test('double elimination invalidates affected winner and loser paths and optional reset picks', () => {
  const state = finishDouble(8, true);
  const before = doubleEngine.evaluate(state);
  const first = before.results.get('W1-0');
  const changed = doubleEngine.chooseWinner(state, first.key, first.loser);
  const after = doubleEngine.evaluate(changed);
  assert.equal(after.champion, null);
  assert.equal(after.results.get('W2-0').winner, undefined);
  assert.equal(after.results.get('L1-0').winner, undefined);
  assert.equal(changed.finalPicks[0], null);
  assert.equal(changed.finalPicks[1], null);
  assert.equal(after.results.get('W1-1').winner, before.results.get('W1-1').winner);
  assert.equal(after.results.get('W2-1').winner, before.results.get('W2-1').winner);
  const resetChanged = doubleEngine.chooseWinner(state, 'F1', before.results.get('F1').entrants[0]);
  const resetAfter = doubleEngine.evaluate(resetChanged);
  assert.equal(resetAfter.results.get('F2').inactive, true);
  assert.equal(resetAfter.state.finalPicks[1], null);
  assert.equal(resetAfter.champion, before.results.get('F1').entrants[0]);
  assert.equal(doubleEngine.chooseWinner(changed, 'F2', 0), changed);
});

test('double saves round-trip, repair invalid picks, and reject missing brackets and unknown formats', () => {
  for (const count of [2, 3, 5, 8, 17]) {
    const state = finishDouble(count, true);
    const restored = engine.normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(JSON.stringify(restored), JSON.stringify(state));
    assert.equal(engine.countPicks(restored), 2 * count - 1);
    assert.equal(engine.normalizeState({ ...state, loserPicks: null }), null);
    assert.equal(engine.normalizeState({ ...state, finalPicks: [] }), null);
    const corrupt = JSON.parse(JSON.stringify(state));
    corrupt.picks[0][0] = 999999;
    const repaired = engine.normalizeState(corrupt);
    assert.equal(doubleEngine.evaluate(repaired).champion, null);
  }
  assert.equal(engine.normalizeState({ ...makeState(2), elimination: 'unknown' }), null);
});

test('format control switches both ways, preserves names, confirms resets, and stores the selected mode', () => {
  const app = loadApp({}, 390);
  app.resize(2);
  app.format('double');
  assert.equal(app.el('formatSelect').value, 'double');
  assert.equal(app.el('picksCount').textContent, '0 / 2');
  assert.equal(app.el('compactTitle').textContent, 'Winners: Final');
  app.pickDouble('W1-0', 0);
  assert.equal(app.el('compactTitle').textContent, 'Grand final');
  app.pickDouble('F1', 1);
  assert.equal(app.el('picksCount').textContent, '2 / 3');
  assert.equal(app.el('championSummary').textContent, 'Not decided');
  assert.match(app.el('compactGrid').innerHTML, /Final reset/);
  app.pickDouble('F2', 0);
  assert.equal(app.el('picksCount').textContent, '3 / 3');
  assert.equal(app.el('compactTitle').textContent, 'Champion');
  assert.equal(app.el('championSummary').textContent, 'Team 01');
  app.setConfirmation(false);
  app.format('single');
  assert.equal(app.el('formatSelect').value, 'double');
  assert.equal(app.el('picksCount').textContent, '3 / 3');
  app.setConfirmation(true);
  app.format('single');
  assert.equal(app.el('picksCount').textContent, '0 / 1');
  assert.equal(app.el('compactTitle').textContent, 'Final');
  app.format('double');
  app.resize(5);
  assert.equal(app.el('picksCount').textContent, '0 / 8');
  const saved = JSON.parse(app.storage.get('bracket-studio-v2'));
  assert.equal(saved.elimination, 'double');
  assert.equal(saved.teams[0], 'Team 01');
  const reloaded = loadApp(Object.fromEntries(app.storage));
  assert.equal(reloaded.el('formatSelect').value, 'double');
  assert.match(reloaded.el('bracketCanvas').innerHTML, /Losers bracket/);
  assert.match(reloaded.el('bracketCanvas').innerHTML, /Winner of/);
  assert.match(reloaded.el('bracketCanvas').innerHTML, /Loser of/);
});

test('double import/export, rename, reset, shuffle, and resizing preserve the format', async () => {
  const completed = finishDouble(5, false);
  const app = loadApp({ 'bracket-studio-v2': JSON.stringify(completed) });
  assert.equal(app.el('picksCount').textContent, '8 / 8');
  app.el('editBtn').click();
  app.el('teamNames').value = 'Alpha\nBeta\nGamma\nDelta\nEpsilon';
  app.el('saveTeamsBtn').click();
  assert.equal(app.el('picksCount').textContent, '8 / 8');
  app.el('exportBtn').click();
  const exported = await app.exported().blob.text();
  assert.equal(JSON.parse(exported).elimination, 'double');
  app.el('resetBtn').click();
  assert.equal(app.el('picksCount').textContent, '0 / 8');
  app.el('shuffleBtn').click();
  assert.equal(app.el('formatSelect').value, 'double');
  app.resize(3);
  assert.equal(app.el('picksCount').textContent, '0 / 4');
  const input = app.el('importInput');
  input.files = [{ text: async () => exported }];
  await input.handlers.change({ target: input });
  assert.equal(app.el('teamCount').textContent, 5);
  assert.equal(app.el('picksCount').textContent, '8 / 8');
  assert.equal(app.el('formatSelect').value, 'double');
});

test('round view skips losers rounds resolved entirely by byes and returns to the first round on reset', () => {
  const app = loadApp({}, 390);
  app.resize(3);
  app.format('double');
  app.pickDouble('W1-0', 0);
  assert.equal(app.el('compactTitle').textContent, 'Winners: Final');
  app.pickDouble('W2-0', 0);
  assert.equal(app.el('compactTitle').textContent, 'Losers round 2');
  app.pickDouble('L2-0', 1);
  assert.equal(app.el('compactTitle').textContent, 'Grand final');
  app.pickDouble('F1', 0);
  assert.equal(app.el('compactTitle').textContent, 'Champion');
  assert.equal(app.el('picksCount').textContent, '4 / 4');
  app.el('resetBtn').click();
  assert.equal(app.el('compactTitle').textContent, 'Winners: Semifinals');
  assert.equal(app.el('picksCount').textContent, '0 / 4');
});
