/**
 * Tests for hermes/utils.js — wrapInput prompt injection protection.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapInput } = require('../../src/hermes/utils');

test('wraps normal string in user_input tags', () => {
  const result = wrapInput('hello world');
  assert.equal(result, '<user_input>hello world</user_input>');
});

test('returns empty string for null input', () => {
  assert.equal(wrapInput(null), '');
  assert.equal(wrapInput(undefined), '');
  assert.equal(wrapInput(''), '');
});

test('strips null bytes from input', () => {
  const result = wrapInput('hello\x00world');
  assert.ok(!result.includes('\x00'), 'null byte should be stripped');
  assert.ok(result.includes('helloworld'), 'content preserved without null byte');
});

test('strips control characters', () => {
  const result = wrapInput('hello\x01\x1fworld');
  assert.ok(!result.includes('\x01'));
  assert.ok(!result.includes('\x1f'));
});

test('truncates to maxLen', () => {
  const long = 'a'.repeat(5000);
  const result = wrapInput(long, 100);
  // content inside tags should be 100 chars
  const inner = result.replace('<user_input>', '').replace('</user_input>', '');
  assert.equal(inner.length, 100);
});

test('preserves newlines and regular whitespace', () => {
  const result = wrapInput('line one\nline two');
  assert.ok(result.includes('line one\nline two'));
});

// ── parseJSON tests ──

const { parseJSON } = require('../../src/hermes/index');

test('parseJSON: parses clean JSON', () => {
  const r = parseJSON('{"valid": true, "score": 80}', null);
  assert.deepEqual(r, { valid: true, score: 80 });
});

test('parseJSON: strips markdown fences', () => {
  const r = parseJSON('```json\n{"valid": true}\n```', null);
  assert.deepEqual(r, { valid: true });
});

test('parseJSON: handles trailing commas', () => {
  const r = parseJSON('{"valid": true, "issues": ["a", "b",],}', null);
  assert.deepEqual(r, { valid: true, issues: ['a', 'b'] });
});

test('parseJSON: handles single-quoted strings', () => {
  const r = parseJSON("{'valid': true, 'score': 70}", null);
  assert.deepEqual(r, { valid: true, score: 70 });
});

test('parseJSON: extracts JSON from surrounding text', () => {
  const r = parseJSON('Here is my answer:\n{"approved": true, "feedback": "looks good"}\nThat is all.', null);
  assert.deepEqual(r, { approved: true, feedback: 'looks good' });
});

test('parseJSON: returns fallback on garbage', () => {
  assert.equal(parseJSON('not json at all', 'fallback'), 'fallback');
  assert.equal(parseJSON('', null), null);
  assert.equal(parseJSON(null, 'fb'), 'fb');
});
