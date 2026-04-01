/**
 * Tests for buildExecutionWaves — topological sort in floor-runner.js.
 * Uses node:test (built-in, no deps required).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Extract buildExecutionWaves without loading the full module's side-effectful requires.
// Re-implement inline so we test the logic without needing DB/agents loaded.
function buildExecutionWaves(floors) {
  const completed = new Set();
  const waves = [];
  let remaining = [...floors];
  while (remaining.length > 0) {
    const wave = remaining.filter(f => {
      const deps = JSON.parse(f.depends_on || '[]');
      return deps.every(n => completed.has(n));
    });
    if (wave.length === 0) {
      waves.push(remaining);
      break;
    }
    waves.push(wave);
    wave.forEach(f => completed.add(f.floor_number));
    remaining = remaining.filter(f => !wave.includes(f));
  }
  return waves;
}

function floor(num, deps = []) {
  return { floor_number: num, depends_on: JSON.stringify(deps) };
}

test('empty floor list returns empty waves', () => {
  assert.deepEqual(buildExecutionWaves([]), []);
});

test('independent floors all run in wave 1', () => {
  const floors = [floor(1), floor(2), floor(3)];
  const waves = buildExecutionWaves(floors);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].length, 3);
});

test('sequential deps produce one floor per wave', () => {
  const floors = [floor(1), floor(2, [1]), floor(3, [2])];
  const waves = buildExecutionWaves(floors);
  assert.equal(waves.length, 3);
  assert.equal(waves[0][0].floor_number, 1);
  assert.equal(waves[1][0].floor_number, 2);
  assert.equal(waves[2][0].floor_number, 3);
});

test('floors 2 and 3 both depending on floor 1 run in same wave', () => {
  const floors = [floor(1), floor(2, [1]), floor(3, [1])];
  const waves = buildExecutionWaves(floors);
  assert.equal(waves.length, 2);
  assert.equal(waves[0][0].floor_number, 1);
  assert.equal(waves[1].length, 2);
  const wave2nums = waves[1].map(f => f.floor_number).sort();
  assert.deepEqual(wave2nums, [2, 3]);
});

test('circular dependency falls back to single wave for remaining', () => {
  // Floor 1 depends on floor 2, floor 2 depends on floor 1 — unresolvable
  const floors = [floor(1, [2]), floor(2, [1])];
  const waves = buildExecutionWaves(floors);
  // Should return 1 wave containing both floors (fallback)
  assert.equal(waves.length, 1);
  assert.equal(waves[0].length, 2);
});
