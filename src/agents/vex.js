const { chat } = require('../llm');
const { addLog, updateFloorVex } = require('../db');
const { wrapInput } = require('../hermes/utils');
const { validateSchema, VEX_RESEARCH_SCHEMA, VEX_BUILD_SCHEMA, SchemaValidationError } = require('../schema-validator');
const { getDesignContext } = require('../hermes/design-intent');

const VEX_RESEARCH_SYSTEM = `You are Vex, the validation agent for AskElira 3. Gate 1: Research Validation.

Your job is to validate Alba's research is GOOD ENOUGH for David to build from. You are not looking for perfection — you are checking for blocking problems only.

Check for BLOCKING issues only:
1. Is the research relevant to the floor? (If yes, that's fine — don't deduct for style)
2. Are there critical missing pieces that would prevent David from building? (Minor gaps are OK — David can fill them)
3. Is there clearly wrong or contradictory information? (Incomplete is NOT wrong)
4. Does it roughly address the success condition? (Partial coverage is OK)

Scoring guide:
- 80-100: Research is solid, David can build from this
- 60-79: Research has gaps but David can still work with it
- 40-59: Research has significant gaps, needs enrichment
- 0-39: Research is wrong, irrelevant, or completely missing key info

BIAS TOWARD PASSING. If the research is on-topic and covers the core requirements, score 65+ and set valid=true. Block (valid=false, score below 50) only when research is wrong, irrelevant, or missing critical information that would guarantee David fails.

CRITICAL: Return ONLY valid JSON. No markdown, no explanation.
Format: {"valid": true/false, "issues": ["issue 1", "issue 2"], "enriched": "additional context or corrections", "score": 0-100}`;

const VEX_BUILD_SYSTEM = `You are Vex, the validation agent for AskElira 3. Gate 2: Build Validation.

Your job is to check if David's code output is FUNCTIONAL and SHIPPABLE. You are not a perfectionist — you check for real problems that would prevent the code from working.

Check for BLOCKING issues only:
1. COMPLETENESS: Are there files with actual code? (Minor TODOs in comments are OK if core logic works)
2. CORRECTNESS: Would this code run without crashing? (Style issues are NOT blocking)
3. SECURITY: Any hardcoded API keys or passwords? SQL injection in user-facing code? (Only flag REAL security issues, not theoretical ones)
4. DELIVERABLE: Does it roughly match what was asked for? (Doesn't need to be perfect)

Scoring guide:
- 80-100: Code works, is complete, matches deliverable
- 60-79: Code mostly works, minor issues that don't block functionality
- 40-59: Code has real problems — missing core logic, syntax errors, wrong language
- 0-39: Code is fundamentally broken, empty, or completely wrong deliverable

BIAS TOWARD PASSING. If the code has real files with implementations that address the deliverable, score 65+ and set valid=true. Block (valid=false, score below 40) only when code is fundamentally broken — won't run, wrong language, empty files, or completely wrong deliverable.

Do NOT deduct points for: coding style, variable naming, missing comments, not using specific libraries, theoretical edge cases, or minor best-practice violations. DO deduct points for: missing core functionality, syntax errors, hardcoded secrets, or completely wrong output.

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

  let reply = await chat(messages, { system: VEX_RESEARCH_SYSTEM, goalId, floorId, agent: 'Vex' });
  let parsed = parseVexJSON(reply);

  // Retry once with strict prompt if parse failed
  if (!parsed || typeof parsed.valid === 'undefined') {
    console.warn(`[Vex/Gate1] JSON parse failed, retrying. Raw start: ${reply.substring(0, 150)}`);
    reply = await chat(
      [{ role: 'user', content: `${messages[0].content}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. Return ONLY valid JSON: {"valid":true,"issues":[],"enriched":"","score":75}` }],
      { system: 'You validate research quality. Return ONLY valid JSON. No other text.', goalId, floorId, agent: 'Vex' }
    );
    parsed = parseVexJSON(reply);
  }

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
    content: `Validate this build output for Floor ${wrapInput(floor.name)}.\n\nFloor Description: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition)}\nExpected Deliverable: ${wrapInput(floor.deliverable)}\n\nDavid's Output:\n${wrapInput(outputStr, 8000)}\n\n${getDesignContext('validate')}\n\nReturn your validation as JSON.`
  }];

  let reply = await chat(messages, { system: VEX_BUILD_SYSTEM, goalId, floorId, agent: 'Vex' });
  let parsed = parseVexJSON(reply);

  // Retry once with strict prompt if parse failed
  if (!parsed || typeof parsed.valid === 'undefined') {
    console.warn(`[Vex/Gate2] JSON parse failed, retrying. Raw start: ${reply.substring(0, 150)}`);
    reply = await chat(
      [{ role: 'user', content: `${messages[0].content}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. Return ONLY valid JSON: {"valid":true,"issues":[],"securityFlags":[],"score":75}` }],
      { system: 'You validate code quality. Return ONLY valid JSON. No other text.', goalId, floorId, agent: 'Vex' }
    );
    parsed = parseVexJSON(reply);
  }

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
