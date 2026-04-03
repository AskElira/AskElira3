/**
 * Strict JSON schema validation for agent outputs.
 * Rejects invalid data instead of defaulting — forces the pipeline to retry or block.
 */

class SchemaValidationError extends Error {
  constructor(agent, violations) {
    const msg = `${agent} output failed schema validation: ${violations.join('; ')}`;
    super(msg);
    this.name = 'SchemaValidationError';
    this.agent = agent;
    this.violations = violations;
  }
}

// ── Schema definitions ──

const VEX_RESEARCH_SCHEMA = {
  name: 'Vex Gate 1',
  fields: {
    valid:    { type: 'boolean', required: true },
    issues:   { type: 'array',   required: false },
    enriched: { type: 'string',  required: false },
    score:    { type: 'number',  required: true },
  },
};

const VEX_BUILD_SCHEMA = {
  name: 'Vex Gate 2',
  fields: {
    valid:         { type: 'boolean', required: true },
    issues:        { type: 'array',   required: false },
    securityFlags: { type: 'array',   required: false },
    score:         { type: 'number',  required: true },
  },
};

const APPROVE_SCHEMA = {
  name: 'Elira Approve',
  fields: {
    approved: { type: 'boolean', required: true },
    feedback: { type: 'string',  required: true },
    fixes:    { type: 'array',   required: false },
  },
};

const FIX_SCHEMA = {
  name: 'Steven Fix',
  fields: {
    diagnosis:         { type: 'string', required: true },
    rootCause:         { type: 'string', required: false },
    fixPlan:           { type: 'array',  required: false },
    patches:           { type: 'array',  required: true },
    verificationSteps: { type: 'array',  required: false },
  },
};

const DAVID_BUILD_SCHEMA = {
  name: 'David Build',
  fields: {
    summary: { type: 'string', required: false },
    files:   { type: 'object', required: true, nonEmpty: true },
  },
};

/**
 * Validate a parsed object against a schema.
 * @param {*} parsed - the parsed JSON object (may be null/undefined)
 * @param {Object} schema - schema definition with name and fields
 * @throws {SchemaValidationError} if validation fails
 * @returns {Object} the validated object (same reference)
 */
function validateSchema(parsed, schema) {
  const violations = [];

  if (parsed === null || parsed === undefined) {
    throw new SchemaValidationError(schema.name, ['Parsed result is null/undefined — JSON parse likely failed']);
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SchemaValidationError(schema.name, [`Expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`]);
  }

  for (const [field, spec] of Object.entries(schema.fields)) {
    const value = parsed[field];

    // Check required fields exist
    if (spec.required && (value === undefined || value === null)) {
      violations.push(`Missing required field: "${field}"`);
      continue;
    }

    // Skip type check for optional missing fields
    if (value === undefined || value === null) continue;

    // Type checks
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          violations.push(`"${field}" must be boolean, got ${typeof value}`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || isNaN(value)) {
          violations.push(`"${field}" must be number, got ${typeof value}`);
        }
        break;
      case 'string':
        if (typeof value !== 'string') {
          violations.push(`"${field}" must be string, got ${typeof value}`);
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          violations.push(`"${field}" must be array, got ${typeof value}`);
        }
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          violations.push(`"${field}" must be object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        } else if (spec.nonEmpty && Object.keys(value).length === 0) {
          violations.push(`"${field}" must be non-empty object`);
        }
        break;
    }
  }

  if (violations.length > 0) {
    throw new SchemaValidationError(schema.name, violations);
  }

  return parsed;
}

module.exports = {
  SchemaValidationError,
  validateSchema,
  VEX_RESEARCH_SCHEMA,
  VEX_BUILD_SCHEMA,
  APPROVE_SCHEMA,
  FIX_SCHEMA,
  DAVID_BUILD_SCHEMA,
};
