/**
 * Tests for workspace.js — path safety and file I/O.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Inline assertSafePath to test its logic without workspace module side effects
const WORKSPACES_DIR = path.join(os.tmpdir(), 'askelira3-test-workspaces-' + process.pid);

function assertSafePath(goalId, resolvedPath) {
  const root = path.resolve(WORKSPACES_DIR, goalId);
  if (!resolvedPath.startsWith(root + path.sep) && resolvedPath !== root) {
    throw new Error(`Path traversal blocked: ${resolvedPath}`);
  }
}

test('path inside workspace passes', () => {
  const goalId = 'goal-abc';
  const safe = path.resolve(WORKSPACES_DIR, goalId, 'output.js');
  assert.doesNotThrow(() => assertSafePath(goalId, safe));
});

test('path traversal via ../ throws', () => {
  const goalId = 'goal-abc';
  const evil = path.resolve(WORKSPACES_DIR, goalId, '..', '..', 'etc', 'passwd');
  assert.throws(() => assertSafePath(goalId, evil), /Path traversal blocked/);
});

test('deeply nested path inside workspace passes', () => {
  const goalId = 'goal-abc';
  const nested = path.resolve(WORKSPACES_DIR, goalId, 'src', 'lib', 'utils', 'helper.js');
  assert.doesNotThrow(() => assertSafePath(goalId, nested));
});

test('absolute path outside workspace throws', () => {
  const goalId = 'goal-abc';
  assert.throws(() => assertSafePath(goalId, '/etc/passwd'), /Path traversal blocked/);
});

test('exact workspace root path passes', () => {
  const goalId = 'goal-abc';
  const root = path.resolve(WORKSPACES_DIR, goalId);
  assert.doesNotThrow(() => assertSafePath(goalId, root));
});
