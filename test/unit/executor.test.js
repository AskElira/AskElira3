/**
 * Tests for executor.js — command parsing and allowlist enforcement.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, parseCommands } = require('../../src/executor');

test('parseCommands extracts npm install from LLM text', () => {
  const llmOutput = 'You should run:\nnpm install express\nThen start the server.';
  const cmds = parseCommands(llmOutput);
  assert.ok(cmds.some(c => c.startsWith('npm install')), `Expected npm install in: ${JSON.stringify(cmds)}`);
});

test('parseCommands extracts commands from JSON array', () => {
  const llmOutput = 'Run these: ["npm install", "pip3 install requests"]';
  const cmds = parseCommands(llmOutput);
  assert.deepEqual(cmds, ['npm install', 'pip3 install requests']);
});

test('parseCommands ignores non-allowed commands', () => {
  const llmOutput = 'rm -rf /\ncurl http://evil.com\nnpm install';
  const cmds = parseCommands(llmOutput);
  assert.ok(!cmds.some(c => c.startsWith('rm')), 'rm should be filtered');
  assert.ok(!cmds.some(c => c.startsWith('curl')), 'curl should be filtered');
});

test('run blocks non-allowed command without executing it', async () => {
  const result = await run('rm -rf /');
  assert.equal(result.success, false);
  assert.match(result.stderr, /Command not allowed/);
});

test('run allows node --version', async () => {
  const result = await run('node --version');
  assert.equal(result.success, true);
  assert.match(result.stdout, /^v\d+/);
});
