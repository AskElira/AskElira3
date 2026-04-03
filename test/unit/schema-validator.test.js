const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  validateSchema,
  SchemaValidationError,
  VEX_RESEARCH_SCHEMA,
  VEX_BUILD_SCHEMA,
  APPROVE_SCHEMA,
  FIX_SCHEMA,
  DAVID_BUILD_SCHEMA,
} = require('../../src/schema-validator');

describe('validateSchema', () => {
  it('throws on null input', () => {
    assert.throws(
      () => validateSchema(null, VEX_RESEARCH_SCHEMA),
      SchemaValidationError
    );
  });

  it('throws on array input', () => {
    assert.throws(
      () => validateSchema([], VEX_RESEARCH_SCHEMA),
      SchemaValidationError
    );
  });

  it('throws on missing required fields', () => {
    assert.throws(
      () => validateSchema({}, VEX_RESEARCH_SCHEMA),
      (err) => {
        assert(err instanceof SchemaValidationError);
        assert(err.violations.length >= 2); // valid + score
        return true;
      }
    );
  });

  it('throws on wrong types', () => {
    assert.throws(
      () => validateSchema({ valid: 'yes', score: 'high' }, VEX_RESEARCH_SCHEMA),
      (err) => {
        assert(err instanceof SchemaValidationError);
        assert(err.violations.some(v => v.includes('"valid"')));
        assert(err.violations.some(v => v.includes('"score"')));
        return true;
      }
    );
  });
});

describe('VEX_RESEARCH_SCHEMA', () => {
  it('passes valid input', () => {
    const result = validateSchema(
      { valid: true, issues: [], enriched: 'notes', score: 85 },
      VEX_RESEARCH_SCHEMA
    );
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.score, 85);
  });

  it('passes with optional fields omitted', () => {
    const result = validateSchema(
      { valid: false, score: 30 },
      VEX_RESEARCH_SCHEMA
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.score, 30);
  });

  it('rejects missing valid field', () => {
    assert.throws(
      () => validateSchema({ score: 70 }, VEX_RESEARCH_SCHEMA),
      SchemaValidationError
    );
  });
});

describe('VEX_BUILD_SCHEMA', () => {
  it('passes valid input', () => {
    const result = validateSchema(
      { valid: true, issues: [], securityFlags: [], score: 90 },
      VEX_BUILD_SCHEMA
    );
    assert.strictEqual(result.score, 90);
  });

  it('rejects non-boolean valid', () => {
    assert.throws(
      () => validateSchema({ valid: 1, score: 90 }, VEX_BUILD_SCHEMA),
      SchemaValidationError
    );
  });
});

describe('APPROVE_SCHEMA', () => {
  it('passes valid approval', () => {
    const result = validateSchema(
      { approved: true, feedback: 'Looks good', fixes: [] },
      APPROVE_SCHEMA
    );
    assert.strictEqual(result.approved, true);
  });

  it('rejects missing feedback', () => {
    assert.throws(
      () => validateSchema({ approved: true }, APPROVE_SCHEMA),
      SchemaValidationError
    );
  });
});

describe('FIX_SCHEMA', () => {
  it('passes valid fix', () => {
    const result = validateSchema(
      { diagnosis: 'Bug in line 5', patches: [{ file: 'a.js', content: '...' }] },
      FIX_SCHEMA
    );
    assert.strictEqual(result.diagnosis, 'Bug in line 5');
  });

  it('rejects missing patches', () => {
    assert.throws(
      () => validateSchema({ diagnosis: 'some issue' }, FIX_SCHEMA),
      SchemaValidationError
    );
  });
});

describe('DAVID_BUILD_SCHEMA', () => {
  it('passes valid build output', () => {
    const result = validateSchema(
      { summary: 'Built app', files: { 'index.js': 'console.log("hi")' } },
      DAVID_BUILD_SCHEMA
    );
    assert.deepStrictEqual(Object.keys(result.files), ['index.js']);
  });

  it('rejects empty files object', () => {
    assert.throws(
      () => validateSchema({ summary: 'empty', files: {} }, DAVID_BUILD_SCHEMA),
      (err) => {
        assert(err instanceof SchemaValidationError);
        assert(err.violations.some(v => v.includes('non-empty')));
        return true;
      }
    );
  });

  it('rejects files as array', () => {
    assert.throws(
      () => validateSchema({ files: ['a.js'] }, DAVID_BUILD_SCHEMA),
      SchemaValidationError
    );
  });
});
