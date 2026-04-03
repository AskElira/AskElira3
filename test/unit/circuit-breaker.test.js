const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CircuitBreaker, CircuitOpenError, STATES } = require('../../src/circuit-breaker');

describe('CircuitBreaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test');
    assert.strictEqual(cb.getState(), STATES.CLOSED);
  });

  it('passes through successful calls', async () => {
    const cb = new CircuitBreaker('test');
    const result = await cb.call(() => Promise.resolve(42));
    assert.strictEqual(result, 42);
    assert.strictEqual(cb.getState(), STATES.CLOSED);
    assert.strictEqual(cb.failures, 0);
  });

  it('tracks failures and opens after maxFailures', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 3, cooldownMs: 60000 });

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    }

    assert.strictEqual(cb.getState(), STATES.OPEN);
    assert.strictEqual(cb.failures, 3);
  });

  it('rejects immediately when OPEN', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 1, cooldownMs: 60000 });
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    assert.strictEqual(cb.getState(), STATES.OPEN);

    await assert.rejects(
      () => cb.call(() => Promise.resolve('should not run')),
      CircuitOpenError
    );
  });

  it('transitions to HALF_OPEN after cooldown', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 1, cooldownMs: 10 });
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    assert.strictEqual(cb.getState(), STATES.OPEN);

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(cb.getState(), STATES.HALF_OPEN);
  });

  it('closes after successful HALF_OPEN call', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 1, cooldownMs: 10 });
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));

    await new Promise(r => setTimeout(r, 20));

    const result = await cb.call(() => Promise.resolve('recovered'));
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(cb.getState(), STATES.CLOSED);
    assert.strictEqual(cb.failures, 0);
  });

  it('re-opens after failed HALF_OPEN call', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 1, cooldownMs: 10 });
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));

    await new Promise(r => setTimeout(r, 20));

    await assert.rejects(() => cb.call(() => Promise.reject(new Error('still broken'))));
    assert.strictEqual(cb.getState(), STATES.OPEN);
  });

  it('resets consecutive failures on success', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 3 });

    // 2 failures
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    assert.strictEqual(cb.failures, 2);

    // 1 success resets
    await cb.call(() => Promise.resolve('ok'));
    assert.strictEqual(cb.failures, 0);
    assert.strictEqual(cb.getState(), STATES.CLOSED);
  });

  it('reset() manually resets to CLOSED', async () => {
    const cb = new CircuitBreaker('test', { maxFailures: 1, cooldownMs: 60000 });
    await assert.rejects(() => cb.call(() => Promise.reject(new Error('fail'))));
    assert.strictEqual(cb.getState(), STATES.OPEN);

    cb.reset();
    assert.strictEqual(cb.getState(), STATES.CLOSED);
    assert.strictEqual(cb.failures, 0);
  });

  it('getInfo() returns correct shape', () => {
    const cb = new CircuitBreaker('myapi', { maxFailures: 5, cooldownMs: 30000 });
    const info = cb.getInfo();
    assert.strictEqual(info.name, 'myapi');
    assert.strictEqual(info.state, STATES.CLOSED);
    assert.strictEqual(info.maxFailures, 5);
    assert.strictEqual(info.cooldownMs, 30000);
    assert.strictEqual(info.failures, 0);
  });
});
