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
