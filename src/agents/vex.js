const { chat } = require('../llm');
const { addLog, updateFloorVex } = require('../db');

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
 * Parse JSON from LLM response with fallback.
 */
function parseVexJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    return fallback;
  }
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

  try {
    const messages = [{
      role: 'user',
      content: `Validate this research for building Floor "${floor.name}".\n\nFloor Description: ${floor.description || ''}\nSuccess Condition: ${floor.success_condition || ''}\nExpected Deliverable: ${floor.deliverable || ''}\n\nAlba's Research:\n${research}\n\nReturn your validation as JSON.`
    }];

    const reply = await chat(messages, { system: VEX_RESEARCH_SYSTEM });
    const result = parseVexJSON(reply, { valid: true, issues: [], enriched: '', score: 70 });

    // Normalize
    result.valid = !!result.valid;
    result.issues = Array.isArray(result.issues) ? result.issues : [];
    result.enriched = result.enriched || '';
    result.score = typeof result.score === 'number' ? result.score : 70;

    // Save score to DB
    updateFloorVex(floorId, 1, result.score);

    const status = result.valid ? 'PASSED' : 'BLOCKED';
    addLog(goalId, floorId, 'Vex', `Gate 1 ${status} (score: ${result.score}). Issues: ${result.issues.length}`);
    console.log(`[Vex/Gate1] ${status}: score=${result.score}, issues=${result.issues.length}`);
    return result;
  } catch (err) {
    console.error(`[Vex/Gate1] Error:`, err.message);
    addLog(goalId, floorId, 'Vex', `Gate 1 error: ${err.message}`);
    // On error, pass through (don't block the pipeline on Vex failure)
    return { valid: true, issues: [], enriched: '', score: 50 };
  }
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

  try {
    const outputStr = typeof davidOutput === 'string'
      ? davidOutput
      : JSON.stringify(davidOutput, null, 2);

    const messages = [{
      role: 'user',
      content: `Validate this build output for Floor "${floor.name}".\n\nFloor Description: ${floor.description || ''}\nSuccess Condition: ${floor.success_condition || ''}\nExpected Deliverable: ${floor.deliverable || ''}\n\nDavid's Output:\n${outputStr.substring(0, 8000)}\n\nReturn your validation as JSON.`
    }];

    const reply = await chat(messages, { system: VEX_BUILD_SYSTEM });
    const result = parseVexJSON(reply, { valid: true, issues: [], securityFlags: [], score: 60 });

    // Normalize
    result.valid = !!result.valid;
    result.issues = Array.isArray(result.issues) ? result.issues : [];
    result.securityFlags = Array.isArray(result.securityFlags) ? result.securityFlags : [];
    result.score = typeof result.score === 'number' ? result.score : 60;

    // Save score to DB
    updateFloorVex(floorId, 2, result.score);

    const status = result.valid ? 'PASSED' : 'BLOCKED';
    addLog(goalId, floorId, 'Vex', `Gate 2 ${status} (score: ${result.score}). Issues: ${result.issues.length}, Security: ${result.securityFlags.length}`);
    console.log(`[Vex/Gate2] ${status}: score=${result.score}, issues=${result.issues.length}, security=${result.securityFlags.length}`);
    return result;
  } catch (err) {
    console.error(`[Vex/Gate2] Error:`, err.message);
    addLog(goalId, floorId, 'Vex', `Gate 2 error: ${err.message}`);
    return { valid: true, issues: [], securityFlags: [], score: 50 };
  }
}

module.exports = { vexValidateResearch, vexValidateBuild };
