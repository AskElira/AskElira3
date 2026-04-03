const { chat } = require('../llm');
const { addLog } = require('../db');
const workspace = require('../pipeline/workspace');
const { parseJSON } = require('../hermes/index');
const { wrapInput } = require('../hermes/utils');
const { validateSchema, DAVID_BUILD_SCHEMA } = require('../schema-validator');

const DAVID_SYSTEM = `You are David, the builder agent for AskElira 3.

Your job is to take a floor description and Alba's research notes, then produce REAL, WORKING FILES.

Rules:
1. Your output must be COMPLETE — no stubs, no "TODO" placeholders, no "implement later"
2. Write real, working code that can be executed
3. If building a Node.js app, include package.json
4. If building a web app, include HTML, CSS, and JS files
5. Include ALL necessary files for the deliverable to work
6. Format your output as a JSON object with files

CRITICAL: Return ONLY valid JSON. No markdown wrapping, no explanation outside the JSON.
Format:
{
  "summary": "Brief summary of what was built",
  "files": {
    "filename.js": "file content here",
    "another/path.json": "content here"
  }
}

Every file must have complete, working content. No file should contain TODO, FIXME, or placeholder text.
If you are writing code, it must be syntactically correct and logically complete.`;

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

  userMessage += '\n\nBuild the complete deliverable. Return JSON with all files.';

  const reply = await chat(
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
  // Pattern: ```lang\n// filename\ncontent\n```
  const blockRegex = /```[\w]*\n(?:\/\/\s*|#\s*)?(\S+\.[\w.]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    files[match[1]] = match[2].trim();
  }
  // Pattern: ### filename.js\n```\ncontent\n```
  const headerRegex = /###?\s+(\S+\.[\w.]+)\s*\n```[\w]*\n([\s\S]*?)```/g;
  while ((match = headerRegex.exec(text)) !== null) {
    if (!files[match[1]]) {
      files[match[1]] = match[2].trim();
    }
  }
  return files;
}

module.exports = { davidBuild };
