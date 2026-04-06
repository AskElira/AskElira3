const fs = require('fs');
const path = require('path');
const { chat } = require('../llm');
const { config } = require('../config');
const { validateSchema, APPROVE_SCHEMA, FIX_SCHEMA } = require('../schema-validator');

const SOUL = fs.readFileSync(path.join(__dirname, 'SOUL.md'), 'utf8');
const { getDesignContext } = require('./design-intent');

let agentsRules = '';
try {
  agentsRules = fs.readFileSync(path.join(__dirname, 'AGENTS.md'), 'utf8');
} catch (e) {
  // AGENTS.md is optional
}

console.log('[Hermes] Soul loaded:', SOUL.length, 'chars');

const { wrapInput } = require('./utils');
const browser = require('./browser');

function getSoul() {
  return SOUL;
}

/**
 * Repair common JSON malformations from LLMs before parsing.
 * Handles: trailing commas, single quotes, unquoted keys, comments, control chars.
 */
function repairJSON(text) {
  let s = text;
  // Strip single-line comments (// ...) but not inside strings — simple heuristic
  s = s.replace(/(?<!["\w])\/\/[^\n]*/g, '');
  // Strip multi-line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Replace single-quoted strings with double-quoted (simple cases)
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Quote unquoted keys: word: → "word":
  s = s.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
  // Strip control characters except newlines and tabs
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return s;
}

/**
 * Parse JSON from LLM response, handling markdown code blocks and fallbacks.
 * Tries: direct parse → repaired parse → substring extraction → fallback.
 */
function parseJSON(text, fallback) {
  if (!text || typeof text !== 'string') return fallback;

  // Strip markdown fences first
  const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();

  // 1. Direct parse
  try { return JSON.parse(cleaned); } catch (_) {}

  // 2. Repaired parse
  const repaired = repairJSON(cleaned);
  try { return JSON.parse(repaired); } catch (_) {}

  // 3. Extract substrings — try array and object candidates, longest first
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const candidates = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === open) {
        for (let j = cleaned.length; j > i; j--) {
          if (cleaned[j - 1] === close) {
            candidates.push(cleaned.slice(i, j));
            break;
          }
        }
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      try { return JSON.parse(candidate); } catch (_) {}
      // Try repaired version of the candidate too
      try { return JSON.parse(repairJSON(candidate)); } catch (_) {}
    }
  }

  return fallback;
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
  const { formatContext: userCtx } = require('../user-model');
  const userContext = userCtx();
  const contextPrefix = userContext ? `${userContext}\n\n` : '';
  const messages = [{
    role: 'user',
    content: `${contextPrefix}I need you to design a building plan for this goal:\n\n${wrapInput(goalText)}\n\nDecompose it into 3-7 floors. Each floor must have a name, description, successCondition, deliverable, and dependsOn.\n\nFor any floor with a frontend/UI deliverable, the successCondition must include design intent alignment (CSS variables used, correct typography, elevation model respected).\n\nCRITICAL: Return ONLY a valid JSON array. No markdown, no explanation, just the JSON.\nFormat: [{"name":"Floor Name","description":"What this floor does","successCondition":"How to verify it is done","deliverable":"What concrete files/artifacts David should produce","dependsOn":[]}]\n\ndependsOn is an array of floor numbers (1-indexed) this floor depends on. Use [] if none. Example: Floor 3 builds on Floor 1's output → "dependsOn":[1]`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + '\n\n' + getDesignContext('full') + '\n\nYou are in ELIRA MODE. You are designing a building plan.',
    isBuildingTask: true,
    goalId,
    agent: 'Elira',
  });

  let floors = parseJSON(reply, null);

  // Retry once with a more direct prompt if parse failed
  if (!Array.isArray(floors) || floors.length === 0) {
    console.warn('[Hermes/Elira] Plan parse failed, retrying with stricter prompt. Raw:', reply.substring(0, 200));
    const retryMessages = [{
      role: 'user',
      content: `Return ONLY a JSON array — no text before or after, no markdown, no explanation.\n\nGoal: ${wrapInput(goalText)}\n\nJSON array of 3-7 floors:\n[{"name":"...","description":"...","successCondition":"...","deliverable":"...","dependsOn":[]}]`
    }];
    const retryReply = await chat(retryMessages, {
      model: config.eliraModel,
      system: 'You output only valid JSON. Nothing else.',
      isBuildingTask: true,
      goalId,
      agent: 'Elira',
    });
    floors = parseJSON(retryReply, null);
  }

  if (!Array.isArray(floors) || floors.length === 0) {
    console.error('[Hermes/Elira] Failed to parse plan after retry:', reply.substring(0, 300));
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
 * Build a structured review summary from David's output.
 * Shows ALL files with previews — never truncates. Elira sees the full picture.
 */
function summarizeForReview(davidOutput) {
  try {
    const parsed = typeof davidOutput === 'string' ? JSON.parse(davidOutput) : davidOutput;
    const files = parsed.files || {};
    const fileEntries = Object.entries(files);
    if (fileEntries.length === 0) return wrapInput(davidOutput, 6000);

    const fileList = fileEntries.map(([name, content]) => {
      const text = String(content || '');
      const lines = text.split('\n').length;
      const chars = text.length;
      // Show first 300 chars of each file so Elira can assess quality
      const preview = text.substring(0, 300);
      return `### ${name} (${lines} lines, ${chars} chars)\n\`\`\`\n${preview}${chars > 300 ? '\n...' : ''}\n\`\`\``;
    });

    return `Summary: ${parsed.summary || 'Build output'}\n\nFiles delivered (${fileEntries.length}):\n\n${fileList.join('\n\n')}`;
  } catch (_) {
    // If it's not JSON, send a capped version
    return wrapInput(davidOutput, 12000);
  }
}

/**
 * Elira mode: approve or reject a floor's output.
 * Returns { approved: boolean, feedback: string, fixes: string[] }
 */
async function hermesApprove(floor, davidOutput, { goalId } = {}) {
  console.log(`[Hermes/Elira] Reviewing floor: ${floor.name}`);
  const { formatContext: userCtx } = require('../user-model');
  const userContext = userCtx();
  const contextPrefix = userContext ? `${userContext}\n\n` : '';

  // Build a structured summary so Elira sees ALL files (never truncated)
  const outputSummary = summarizeForReview(davidOutput);

  // Only inject design context for UI-related floors
  const isUIFloor = /frontend|ui|html|css|dashboard|page|layout|component|render|display|visual|style/i
    .test(`${floor.name} ${floor.description || ''} ${floor.deliverable || ''}`);
  const designCtx = isUIFloor ? getDesignContext('build') : '';
  const designNote = isUIFloor
    ? '\n\nIf this floor produced frontend/UI files, check for design intent violations in addition to functional correctness.'
    : '';

  const messages = [{
    role: 'user',
    content: `${contextPrefix}Review this deliverable.\n\nFloor: ${wrapInput(floor.name)}\nDescription: ${wrapInput(floor.description)}\nSuccess Condition: ${wrapInput(floor.success_condition || floor.successCondition || 'Meets description')}\nExpected Deliverable: ${wrapInput(floor.deliverable || 'Complete implementation')}\n\nDavid's Output:\n${outputSummary}${designNote}\n\nCRITICAL: Return ONLY valid JSON. No markdown, no explanation.\nFormat: {"approved": true/false, "feedback": "your feedback here", "fixes": ["specific change 1", "specific change 2"]}`
  }];
  const reply = await chat(messages, {
    model: config.eliraModel,
    system: SOUL + (designCtx ? '\n\n' + designCtx : '') +
      '\n\nYou are in ELIRA MODE reviewing a build.' +
      '\n\nAPPROVAL BIAS: Approve if the deliverable is functionally complete and matches the success condition. ' +
      'Minor issues (style, naming, missing comments, edge cases) should be noted in feedback but should NOT block approval. ' +
      'Only reject for: missing core functionality, wrong deliverable, broken code that won\'t run, or security issues.' +
      (isUIFloor ? '' : ' Design intent checks do not apply to this non-UI floor.'),
    isBuildingTask: true,
    goalId: goalId || floor.goal_id,
    floorId: floor.id,
    agent: 'Elira',
  });

  let parsed = parseJSON(reply, null);

  // Retry once with strict prompt if parse failed
  if (!parsed || typeof parsed.approved === 'undefined') {
    console.warn(`[Hermes/Elira] Approve JSON parse failed, retrying. Raw start: ${reply.substring(0, 150)}`);
    const retryReply = await chat(
      [{ role: 'user', content: `${messages[0].content}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. Return ONLY valid JSON: {"approved":true,"feedback":"...","fixes":[]}` }],
      { system: 'You review code deliverables. Return ONLY valid JSON. No other text.', model: config.eliraModel, isBuildingTask: true, goalId: goalId || floor.goal_id, floorId: floor.id, agent: 'Elira' }
    );
    parsed = parseJSON(retryReply, null);
  }

  const result = validateSchema(parsed, APPROVE_SCHEMA);

  // Normalize optional fields
  result.fixes = result.fixes || [];

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
    system: SOUL + '\n\n' + getDesignContext('validate') + '\n\nYou are in STEVEN MODE. Diagnose the root cause and produce working patches.',
    isBuildingTask: true,
    goalId: goalId || floor.goal_id,
    floorId: floor.id,
    agent: 'Steven',
  });

  let parsed = parseJSON(reply, null);

  // Retry once with strict prompt if parse failed
  if (!parsed || !parsed.patches) {
    console.warn(`[Hermes/Steven] Fix JSON parse failed, retrying. Raw start: ${reply.substring(0, 150)}`);
    const retryReply = await chat(
      [{ role: 'user', content: `${messages[0].content}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. Return ONLY valid JSON: {"diagnosis":"...","patches":[{"file":"...","action":"create","content":"..."}]}` }],
      { system: 'You fix broken code. Return ONLY valid JSON. No other text.', model: config.eliraModel, isBuildingTask: true, goalId: goalId || floor.goal_id, floorId: floor.id, agent: 'Steven' }
    );
    parsed = parseJSON(retryReply, null);
  }

  const result = validateSchema(parsed, FIX_SCHEMA);

  // Normalize optional fields
  result.rootCause = result.rootCause || 'Unknown';
  result.fixPlan = result.fixPlan || [];
  result.verificationSteps = result.verificationSteps || [];

  console.log(`[Hermes/Steven] Fix plan: ${result.fixPlan.length} steps, ${result.patches.length} patches`);
  return result;
}

/**
 * Chat mode: direct conversation with Hermes.
 * Returns response string using full SOUL as system prompt.
 */
async function hermesChat(messages, systemOverride = null) {
  console.log('[Hermes] Chat request');
  const designCtx = getDesignContext('full');

  // Inject live goal/floor context so the model can answer status questions directly
  let goalContext = '';
  try {
    const { listGoals, listFloors } = require('../db');
    const goals = listGoals();
    if (goals.length > 0) {
      const lines = goals.slice(0, 10).map(g => {
        const floors = listFloors(g.id);
        const live = floors.filter(f => f.status === 'live').length;
        const blocked = floors.filter(f => f.status === 'blocked').length;
        const safeName = g.text.replace(/[\n\r]/g, ' ').substring(0, 80);
        return `- "${safeName}" [${g.status}] — ${floors.length} floors (${live} live, ${blocked} blocked)`;
      });
      goalContext = `\n\nCurrent Goals:\n${lines.join('\n')}`;
    }
  } catch (_) {}

  const systemPrompt = (systemOverride
    ? SOUL + '\n\n' + designCtx + '\n\n' + systemOverride
    : SOUL + '\n\n' + designCtx) + goalContext
    + '\n\nCRITICAL: You have NO tools. Do NOT output TOOL_CALL, tool_call, invoke, search, or function tags. You cannot browse the web or call APIs. Answer directly from your knowledge. If asked to look something up, answer from what you know and suggest the user search manually if needed.';

  const reply = await chat(messages, {
    model: config.eliraModel,
    system: systemPrompt,
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

module.exports = { hermesReason, hermesPlan, hermesApprove, hermesFix, hermesChat, hermesRoute, hermesExecPlan, getSoul, parseJSON, browser };
