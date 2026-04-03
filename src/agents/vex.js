const { chat } = require('../llm');
const { addLog, updateFloorVex } = require('../db');
const { wrapInput } = require('../hermes/utils');
const { validateSchema, VEX_RESEARCH_SCHEMA, VEX_BUILD_SCHEMA, SchemaValidationError } = require('../schema-validator');

const VEX_RESEARCH_SYSTEM = `You are Vex, the validation agent for AskElira 3. Gate 1: Research Validation.

Your job is to validate Alba's research before David uses it to build.

Check:
1. Is the research relevant to the floor's requirements?
2. Is it complete enough to build from? Are there missing pieces?
3. Are there any contradictions or clearly wrong information?
4. Does the research address the success condition?

CRITICAL: Return ONLY valid JSON. No markdown, no explanation.
Format: {"valid": true/false, "issues": ["issue 1", "issue 2"], "enriched": "additional context or corrections", "score": 0-100}`;

const VEX_BUILD_SYSTEM = `You are Vex, the validation agent for AskElira 3. Gate 2: Build Validation.

Your job is to validate David's code output before Elira reviews it.

Check:
1. COMPLETENESS: Does the output contain real, complete implementations? No TODOs, no stubs, no placeholders?
2. CORRECTNESS: Does the code look correct? Will it run without errors?
3. SECURITY: Any hardcoded secrets, SQL injection, XSS, or other security issues?
4. DELIVERABLE MATCH: Does it match what the floor's deliverable field specified?
5. SUCCESS CONDITION: Will this output satisfy the floor's success condition?

CRITICAL: Return ONLY valid JSON. No markdown, no explanation.
Format: {"valid": true/false, "issues": ["issue 1"], "securityFlags": ["flag 1"], "score": 0-100}`;

/**
 * Parse JSON from LLM response — strict, no fallback.
 * Uses the shared parseJSON then validates against schema.
 */
const { parseJSON: parseVexJSON_shared } = require('../hermes/index');
function parseVexJSON(text) {
  return parseVexJSON_shared(text, null);
}

/**
 * Vex Gate 1: Validate Alba's research before David builds.
 * @param {Object} floor - floor record
 * @param {string} research - Alba's research text
 * @returns {Promise<{valid: boolean, issues: string[], enriched: string, score: number}>}
 */
async function vexValidateResearch(floor, research) {
  console.log(`[Vex/Gate1] Validating research for: ${floor.name}`);
  const goalId = floor.goal_id;
  const floorId = floor.id;
  addLog(goalId, floorId, 'Vex', `Gate 1: Validating research for ${floor.name}`);

  const messages = [{
    role: 'user',
    content: `Validate this research for building Floor ${wrapInput(floor.name)}.\n\nFloor Description: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition)}\nExpected Deliverable: ${wrapInput(floor.deliverable)}\n\nAlba's Research:\n${wrapInput(research, 3000)}\n\nReturn your validation as JSON.`
  }];

  const reply = await chat(messages, { system: VEX_RESEARCH_SYSTEM, goalId, floorId, agent: 'Vex' });
  const parsed = parseVexJSON(reply);
  const result = validateSchema(parsed, VEX_RESEARCH_SCHEMA);

  // Normalize optional fields that passed validation
  result.issues = result.issues || [];
  result.enriched = result.enriched || '';

  // Save score to DB
  updateFloorVex(floorId, 1, result.score);

  const status = result.valid ? 'PASSED' : 'BLOCKED';
  addLog(goalId, floorId, 'Vex', `Gate 1 ${status} (score: ${result.score}). Issues: ${result.issues.length}`);
  console.log(`[Vex/Gate1] ${status}: score=${result.score}, issues=${result.issues.length}`);
  return result;
}

/**
 * Vex Gate 2: Validate David's build output before Elira approves.
 * @param {Object} floor - floor record
 * @param {Object|string} davidOutput - David's build output
 * @param {string} goalId - for logging
 * @returns {Promise<{valid: boolean, issues: string[], securityFlags: string[], score: number}>}
 */
async function vexValidateBuild(floor, davidOutput, goalId) {
  console.log(`[Vex/Gate2] Validating build for: ${floor.name}`);
  const floorId = floor.id;
  addLog(goalId, floorId, 'Vex', `Gate 2: Validating build for ${floor.name}`);

  const outputStr = typeof davidOutput === 'string'
    ? davidOutput
    : JSON.stringify(davidOutput, null, 2);

  const messages = [{
    role: 'user',
    content: `Validate this build output for Floor ${wrapInput(floor.name)}.\n\nFloor Description: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition)}\nExpected Deliverable: ${wrapInput(floor.deliverable)}\n\nDavid's Output:\n${wrapInput(outputStr, 8000)}\n\nReturn your validation as JSON.`
  }];

  const reply = await chat(messages, { system: VEX_BUILD_SYSTEM, goalId, floorId, agent: 'Vex' });
  const parsed = parseVexJSON(reply);
  const result = validateSchema(parsed, VEX_BUILD_SCHEMA);

  // Normalize optional fields that passed validation
  result.issues = result.issues || [];
  result.securityFlags = result.securityFlags || [];

  // Save score to DB
  updateFloorVex(floorId, 2, result.score);

  const status = result.valid ? 'PASSED' : 'BLOCKED';
  addLog(goalId, floorId, 'Vex', `Gate 2 ${status} (score: ${result.score}). Issues: ${result.issues.length}, Security: ${result.securityFlags.length}`);
  console.log(`[Vex/Gate2] ${status}: score=${result.score}, issues=${result.issues.length}, security=${result.securityFlags.length}`);
  return result;
}

module.exports = { vexValidateResearch, vexValidateBuild };
