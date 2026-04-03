/**
 * Circuit breaker for external API calls.
 * After maxFailures consecutive failures, disables the API for cooldownMs.
 *
 * States:
 *   CLOSED    — normal operation, requests pass through
 *   OPEN      — circuit tripped, requests rejected immediately
 *   HALF_OPEN — cooldown expired, one test request allowed
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitOpenError extends Error {
  constructor(name, nextRetryAt) {
    super(`Circuit breaker "${name}" is OPEN — API disabled after consecutive failures. Retry after ${new Date(nextRetryAt).toISOString()}`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.nextRetryAt = nextRetryAt;
  }
}

class CircuitBreaker {
  /**
   * @param {string} name - identifier for logging (e.g., 'tavily', 'brave')
   * @param {Object} opts
   * @param {number} [opts.maxFailures=3] - consecutive failures before opening
   * @param {number} [opts.cooldownMs=60000] - ms to wait before half-open test
   */
  constructor(name, { maxFailures = 3, cooldownMs = 60000 } = {}) {
    this.name = name;
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.lastFailureTime = 0;
    this.openedAt = 0;
  }

  /**
   * Execute an async function through the circuit breaker.
   * @param {Function} fn - async function to execute
   * @returns {Promise<*>} result of fn()
   * @throws {CircuitOpenError} if circuit is open
   */
  async call(fn) {
    // OPEN: check if cooldown has passed
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = STATES.HALF_OPEN;
        console.log(`[CircuitBreaker/${this.name}] HALF_OPEN — allowing test request`);
      } else {
        throw new CircuitOpenError(this.name, this.openedAt + this.cooldownMs);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      console.log(`[CircuitBreaker/${this.name}] CLOSED — test request succeeded`);
    }
    this.failures = 0;
    this.state = STATES.CLOSED;
  }

  _onFailure(err) {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      // Half-open test failed — reopen
      this.state = STATES.OPEN;
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker/${this.name}] OPEN — half-open test failed: ${err.message}`);
      return;
    }

    if (this.failures >= this.maxFailures) {
      this.state = STATES.OPEN;
      this.openedAt = Date.now();
      console.warn(`[CircuitBreaker/${this.name}] OPEN — ${this.failures} consecutive failures. Disabling for ${this.cooldownMs / 1000}s`);
    }
  }

  getState() {
    // Auto-transition if cooldown expired while nobody called
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        return STATES.HALF_OPEN;
      }
    }
    return this.state;
  }

  getInfo() {
    return {
      name: this.name,
      state: this.getState(),
      failures: this.failures,
      maxFailures: this.maxFailures,
      cooldownMs: this.cooldownMs,
      lastFailureTime: this.lastFailureTime || null,
      openedAt: this.openedAt || null,
    };
  }

  reset() {
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    console.log(`[CircuitBreaker/${this.name}] Manually reset to CLOSED`);
  }
}

// Registry of all breakers for status endpoint
const _registry = {};

function createBreaker(name, opts) {
  const breaker = new CircuitBreaker(name, opts);
  _registry[name] = breaker;
  return breaker;
}

function getAllBreakers() {
  return Object.values(_registry).map(b => b.getInfo());
}

module.exports = { CircuitBreaker, CircuitOpenError, createBreaker, getAllBreakers, STATES };
