const { chat } = require('../llm');
const { addLog } = require('../db');
const workspace = require('../pipeline/workspace');
const { parseJSON } = require('../hermes/index');
const { wrapInput } = require('../hermes/utils');
const { validateSchema, DAVID_BUILD_SCHEMA } = require('../schema-validator');
const { getDesignContext } = require('../hermes/design-intent');

const DAVID_SYSTEM = `You are David, the builder agent. You output ONLY JSON. Never output anything except a JSON object.

Your entire response must be a single JSON object. No text before it. No text after it. No markdown fences.

The JSON object has exactly two keys:
- "summary": a one-sentence description of what you built
- "files": an object where each key is a filename and each value is the complete file content as a string

Example of your ENTIRE response (nothing else):
{"summary":"Built a hello world app","files":{"app.js":"console.log('hello');","package.json":"{\\n  \\"name\\": \\"app\\"\\n}"}}

Rules for the files you create:
- Every file must have complete, working content
- No TODO, FIXME, or placeholder text
- Code must be syntactically correct
- Include ALL necessary files (package.json, requirements.txt, etc.)
- For frontend: use CSS variables (var(--accent), var(--panel), etc.) not hardcoded hex

IMPORTANT: Your response starts with { and ends with }. Nothing else.`;

/**
 * Build the deliverable for a floor based on research.
 * Writes real files to the workspace directory.
 *
 * @param {Object} floor - floor record
 * @param {string} research - Alba's research notes
 * @param {string} goalId - goal ID for workspace
 * @param {string} [feedback] - Rejection feedback from previous iteration
 * @param {string} [vexFeedback] - Vex Gate 2 issues from previous iteration
 * @returns {Promise<{summary: string, files: string[], output: string}>}
 */
async function davidBuild(floor, research, goalId, feedback, vexFeedback) {
  const floorName = floor.name;
  const floorId = floor.id;

  console.log(`[David] Building: ${floorName}`);
  addLog(goalId, floorId, 'David', `Starting build for: ${floorName}`);

  let userMessage = `Goal Floor: ${wrapInput(floorName)}
Description: ${wrapInput(floor.description)}
Success Condition: ${wrapInput(floor.success_condition || floor.successCondition || 'Meets description')}
Deliverable: ${wrapInput(floor.deliverable || 'Complete implementation')}

Alba's Research:
${wrapInput(research, 3000)}`;

  if (feedback) {
    userMessage += `\n\nPrevious Rejection Feedback (MUST address these):
${wrapInput(feedback)}`;
  }

  if (vexFeedback) {
    userMessage += `\n\nVex Validation Issues (MUST fix these):
${wrapInput(vexFeedback)}`;
  }

  // Check if workspace already has files from previous iteration (capped to avoid context overflow)
  const existingFiles = workspace.listFiles(goalId);
  if (existingFiles.length > 0) {
    const summary = workspace.getWorkspaceSummary(goalId, { maxChars: 800, linesPerFile: 10 });
    userMessage += `\n\nExisting files: ${wrapInput(summary, 2000)}`;
  }

  userMessage += `\n\n${getDesignContext('build')}`;
  userMessage += '\n\nBuild the complete deliverable. Return JSON with all files.';

  let reply = await chat(
    [{ role: 'user', content: userMessage }],
    { system: DAVID_SYSTEM, maxTokens: 8192, goalId, floorId, agent: 'David' }
  );

  // Parse the response
  let parsed = parseJSON(reply, null);

  // Handle various response formats — try markdown extraction if JSON parse failed
  if (!parsed || !parsed.files) {
    const filesMap = extractFilesFromMarkdown(reply);
    if (Object.keys(filesMap).length > 0) {
      parsed = { summary: 'Built from markdown output', files: filesMap };
    }
  }

  // Retry once with strict JSON-only prompt if parse failed
  if (!parsed || !parsed.files) {
    console.warn(`[David] JSON parse failed, retrying with strict prompt. Raw start: ${reply.substring(0, 150)}`);
    reply = await chat(
      [{ role: 'user', content: `${userMessage}\n\nPREVIOUS ATTEMPT FAILED TO PARSE. You MUST return ONLY a JSON object. No text before or after. No markdown fences. Just: {"summary":"...","files":{"filename.ext":"content"}}` }],
      { system: 'You are a code builder. Return ONLY valid JSON with "summary" and "files" keys. No other text.', maxTokens: 8192, goalId, floorId, agent: 'David' }
    );
    parsed = parseJSON(reply, null);
    if (!parsed || !parsed.files) {
      const filesMap = extractFilesFromMarkdown(reply);
      if (Object.keys(filesMap).length > 0) {
        parsed = { summary: 'Built from markdown output (retry)', files: filesMap };
      }
    }
  }

  // Strict validation — must have files object with at least one entry
  validateSchema(parsed, DAVID_BUILD_SCHEMA);

  // Write files to workspace
  const writtenFiles = [];
  workspace.ensureGoalDir(goalId);

  for (const [filename, content] of Object.entries(parsed.files)) {
    if (typeof content === 'string' && content.trim()) {
      workspace.writeFile(goalId, filename, content);
      writtenFiles.push(filename);
    }
  }

  addLog(goalId, floorId, 'David', `Build complete: ${writtenFiles.length} files written`);
  console.log(`[David] Build complete for: ${floorName} (${writtenFiles.length} files)`);

  return {
    summary: parsed.summary || `Built ${writtenFiles.length} files for ${floorName}`,
    files: writtenFiles,
    output: JSON.stringify(parsed, null, 2),
  };
}

/**
 * Fallback: extract files from markdown code blocks.
 * Looks for patterns like: ### filename.js or ```js // filename.js
 */
function extractFilesFromMarkdown(text) {
  const files = {};
  let match;

  // Pattern 1: ```lang\n// filename\ncontent\n```
  const blockRegex = /```[\w]*\n(?:\/\/\s*|#\s*)?(\S+\.[\w.]+)\n([\s\S]*?)```/g;
  while ((match = blockRegex.exec(text)) !== null) {
    files[match[1]] = match[2].trim();
  }

  // Pattern 2: ### filename.js\n```\ncontent\n```
  const headerRegex = /###?\s+(\S+\.[\w.]+)\s*\n```[\w]*\n([\s\S]*?)```/g;
  while ((match = headerRegex.exec(text)) !== null) {
    if (!files[match[1]]) files[match[1]] = match[2].trim();
  }

  // Pattern 3: **filename.js**\n```\ncontent\n```  (MiniMax bold headers)
  const boldRegex = /\*\*(\S+\.[\w.]+)\*\*\s*\n```[\w]*\n([\s\S]*?)```/g;
  while ((match = boldRegex.exec(text)) !== null) {
    if (!files[match[1]]) files[match[1]] = match[2].trim();
  }

  // Pattern 4: `filename.js`:\n```\ncontent\n```  (backtick filename, must be at line start)
  const backtickRegex = /(?:^|\n)`(\S+\.[\w.]+)`[:\s]*\n```[\w]*\n([\s\S]*?)```/g;
  while ((match = backtickRegex.exec(text)) !== null) {
    if (!files[match[1]]) files[match[1]] = match[2].trim();
  }

  // Pattern 5: File: filename.js\n```\ncontent\n```
  const fileHeaderRegex = /(?:File|Filename|Path)[:\s]+(\S+\.[\w.]+)\s*\n```[\w]*\n([\s\S]*?)```/gi;
  while ((match = fileHeaderRegex.exec(text)) !== null) {
    if (!files[match[1]]) files[match[1]] = match[2].trim();
  }

  return files;
}

module.exports = { davidBuild };
