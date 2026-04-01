const fs = require('fs');
const path = require('path');
const { chat } = require('../llm');
const { config } = require('../config');

const SOUL = fs.readFileSync(path.join(__dirname, 'SOUL.md'), 'utf8');

let agentsRules = '';
try {
  agentsRules = fs.readFileSync(path.join(__dirname, 'AGENTS.md'), 'utf8');
} catch (e) {
  // AGENTS.md is optional
}

console.log('[Hermes] Soul loaded:', SOUL.length, 'chars');

const { wrapInput } = require('./utils');

function getSoul() {
  return SOUL;
}

/**
 * Parse JSON from LLM response, handling markdown code blocks and fallbacks.
 */
function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to extract JSON object or array
    const objMatch = text.match(/\{[\s\S]*\}/);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch (e2) { /* fall through */ }
    }
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch (e2) { /* fall through */ }
    }
    return fallback;
  }
}

/**
 * Elira mode: reason through a problem before acting.
 * Returns structured reasoning as a string.
 */
async function hermesReason(context, task) {
  const messages = [{
    role: 'user',
    content: `## Context\n${wrapInput(context)}\n\n## Task\n${wrapInput(task)}\n\nReason through this step by step before giving your answer. Structure your response as:\n\n**UNDERSTAND**: What is actually being asked?\n**DIAGNOSE**: What is the current state? What is wrong?\n**PLAN**: What are the possible approaches? Which is best and why?\n**RECOMMEND**: What should we do?`
  }];
  const response = await chat(messages, {
    system: SOUL + '\n\nYou are in ELIRA MODE. Reason deeply.',
    model: config.eliraModel,
    isBuildingTask: true,
    agent: 'Elira',
  });
  return response;
}

/**
 * Elira mode: plan a goal into floors.
 * Returns array of floor objects with name, description, successCondition, deliverable.
 */
async function hermesPlan(goalText, { goalId } = {}) {
  console.log('[Hermes/Elira] Planning goal:', goalText.substring(0, 80));
  const messages = [{
    role: 'user',
    content: `I need you to design a building plan for this goal:\n\n${wrapInput(goalText)}\n\nDecompose it into 3-7 floors. Each floor must have a name, description, successCondition, and deliverable.\n\nCRITICAL: Return ONLY a valid JSON array. No markdown, no explanation, just the JSON.\nFormat: [{"name":"Floor Name","description":"What this floor does","successCondition":"How to verify it is done","deliverable":"What concrete files/artifacts David should produce"}]`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + '\n\nYou are in ELIRA MODE. You are designing a building plan.',
    isBuildingTask: true,
    goalId,
    agent: 'Elira',
  });

  const floors = parseJSON(reply, null);
  if (!Array.isArray(floors) || floors.length === 0) {
    console.error('[Hermes/Elira] Failed to parse plan:', reply.substring(0, 300));
    throw new Error('Hermes/Elira returned invalid plan JSON');
  }

  // Ensure each floor has all required fields
  for (const f of floors) {
    f.name = f.name || 'Unnamed Floor';
    f.description = f.description || '';
    f.successCondition = f.successCondition || 'Meets the floor description';
    f.deliverable = f.deliverable || f.description;
  }

  console.log(`[Hermes/Elira] Plan complete: ${floors.length} floors`);
  return floors;
}

/**
 * Elira mode: approve or reject a floor's output.
 * Returns { approved: boolean, feedback: string, fixes: string[] }
 */
async function hermesApprove(floor, davidOutput, { goalId } = {}) {
  console.log(`[Hermes/Elira] Reviewing floor: ${floor.name}`);
  const messages = [{
    role: 'user',
    content: `Review this deliverable.\n\nFloor: ${wrapInput(floor.name)}\nDescription: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition || floor.successCondition || 'Meets description')}\nExpected Deliverable: ${wrapInput(floor.deliverable || 'Complete implementation')}\n\nDavid's Output:\n${wrapInput(typeof davidOutput === 'string' ? davidOutput : JSON.stringify(davidOutput, null, 2), 8000)}\n\nCRITICAL: Return ONLY valid JSON. No markdown, no explanation.\nFormat: {"approved": true/false, "feedback": "your feedback here", "fixes": ["specific change 1", "specific change 2"]}`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + '\n\nYou are in ELIRA MODE. You are reviewing a build for approval.',
    isBuildingTask: true,
    goalId: goalId || floor.goal_id,
    floorId: floor.id,
    agent: 'Elira',
  });

  const result = parseJSON(reply, { approved: false, feedback: 'Failed to parse approval response', fixes: [] });

  // Normalize
  result.approved = !!result.approved;
  result.feedback = result.feedback || '';
  result.fixes = Array.isArray(result.fixes) ? result.fixes : [];

  const status = result.approved ? 'APPROVED' : 'REJECTED';
  console.log(`[Hermes/Elira] ${status}: ${floor.name}`);
  return result;
}

/**
 * Steven mode: diagnose and fix a broken floor.
 * Returns { diagnosis, rootCause, fixPlan, patches, verificationSteps }
 */
async function hermesFix(floor, error, previousOutput, { goalId } = {}) {
  console.log(`[Hermes/Steven] Fixing floor: ${floor.name}`);
  const outputStr = typeof previousOutput === 'string' ? previousOutput : JSON.stringify(previousOutput, null, 2);
  const messages = [{
    role: 'user',
    content: `A floor has failed and needs fixing.\n\nFloor: ${wrapInput(floor.name)}\nDescription: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition || floor.successCondition || 'Meets description')}\nDeliverable: ${wrapInput(floor.deliverable)}\n\nError/Rejection Reason:\n${wrapInput(error)}\n\nPrevious Output:\n${wrapInput(outputStr, 6000)}\n\nCRITICAL: Return ONLY valid JSON. No markdown.\nFormat:\n{"diagnosis":"what went wrong","rootCause":"the root cause","fixPlan":["step 1","step 2"],"patches":[{"file":"filename.js","action":"create","content":"file content here"}],"verificationSteps":["verify step 1"]}`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + '\n\nYou are in STEVEN MODE. Diagnose the root cause and produce working patches.',
    isBuildingTask: true,
    goalId: goalId || floor.goal_id,
    floorId: floor.id,
    agent: 'Steven',
  });

  const result = parseJSON(reply, {
    diagnosis: 'Could not parse fix response',
    rootCause: 'Unknown',
    fixPlan: [],
    patches: [],
    verificationSteps: [],
  });

  // Normalize
  result.diagnosis = result.diagnosis || 'Unknown';
  result.rootCause = result.rootCause || 'Unknown';
  result.fixPlan = Array.isArray(result.fixPlan) ? result.fixPlan : [];
  result.patches = Array.isArray(result.patches) ? result.patches : [];
  result.verificationSteps = Array.isArray(result.verificationSteps) ? result.verificationSteps : [];

  console.log(`[Hermes/Steven] Fix plan: ${result.fixPlan.length} steps, ${result.patches.length} patches`);
  return result;
}

/**
 * Chat mode: direct conversation with Hermes.
 * Returns response string using full SOUL as system prompt.
 */
async function hermesChat(messages, systemOverride = null) {
  console.log('[Hermes] Chat request');
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: systemOverride ? SOUL + '\n\n' + systemOverride : SOUL,
    agent: 'Elira',
  });
  return reply;
}

/**
 * Steven mode: given a workspace state, decide what shell commands to run.
 * Returns array of command strings like ["pip3 install requests", "npm install"]
 */
async function hermesExecPlan(floor, workspaceFiles, errorContext = '') {
  console.log(`[Hermes/Steven] Planning exec commands for: ${floor.name}`);
  const messages = [{
    role: 'user',
    content: `You need to install dependencies or run setup commands for this workspace.\n\nFloor: ${wrapInput(floor.name)}\nWorkspace files: ${wrapInput(workspaceFiles.join(', '))}\n${errorContext ? `Error context: ${wrapInput(errorContext)}` : ''}\n\nLook at the file list and determine what commands need to run (installs, setup, etc.).\nOnly include necessary commands. Allowed: pip3, pip, npm, npx, node, python3, bash, sh.\n\nReturn ONLY a JSON array of command strings. Example: ["pip3 install requests beautifulsoup4", "npm install"]\nIf no commands needed, return: []`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + '\n\nYou are in STEVEN MODE. Determine what shell commands need to run to set up this workspace.',
    isBuildingTask: true,
  });

  const { parseCommands } = require('../executor');
  const parsed = parseJSON(reply, null);
  if (Array.isArray(parsed)) return parsed.filter(c => typeof c === 'string');
  return parseCommands(reply);
}

/**
 * Create a new goal (simple DB operation). Delegates to db module.
 */
async function hermesRoute(goalText) {
  console.log('[Hermes] New goal received:', goalText.substring(0, 80));
  const { createGoal, addLog } = require('../db');
  const goal = createGoal(goalText);
  addLog(goal.id, null, 'Hermes', `Goal created: ${goalText}`);
  return goal;
}

module.exports = { hermesReason, hermesPlan, hermesApprove, hermesFix, hermesChat, hermesRoute, hermesExecPlan, getSoul, parseJSON };
