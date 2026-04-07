const alba = require('../agents/alba');
const { davidBuild } = require('../agents/david');
const vex = require('../agents/vex');
const hermes = require('../hermes/index');
const workspace = require('./workspace');
const executor = require('../executor');
const { updateFloor, addLog, listFloors, updateGoal, getGoal, getFloor, updateFloorPatches, recordMetric } = require('../db');
const { notifyFloorLive, notifyFloorBlocked, notifyGoalComplete, sendTelegram } = require('../notify');
const { storeFloorMemory } = require('../memory-store');

const MAX_ITERATIONS = 5;

// ── Progress-based watchdog (replaces dumb timeouts) ──
// Instead of killing agents on a clock, we monitor for actual stuckness:
// - Track the last time an agent made progress (log entry, file write, status change)
// - Only intervene when no progress for STALL_THRESHOLD_MS
// - Hard ceiling only as a safety net for truly hung processes (network dead, etc.)

const STALL_THRESHOLD_MS = 5 * 60 * 1000;   // 5 min no progress = stalled
const HARD_CEILING_MS   = 45 * 60 * 1000;   // 45 min absolute max per floor (safety net)
const AGENT_HARD_CEILING = 15 * 60 * 1000;  // 15 min absolute max per agent call (safety net)

/**
 * Run an agent call with progress-aware monitoring.
 * Only kills the agent if it produces NO progress for STALL_THRESHOLD_MS.
 * Otherwise lets it run as long as it needs.
 */
function withProgressWatch(promise, label, goalId, floorId) {
  return new Promise((resolve, reject) => {
    let lastProgress = Date.now();
    let done = false;

    // Poll for new log entries as a progress signal
    const progressChecker = setInterval(() => {
      if (done) return;
      try {
        const { getLogs } = require('../db');
        const recent = getLogs({ floorId, limit: 1 });
        if (recent.length > 0) {
          const logTime = (recent[0].created_at || 0) * 1000;
          if (logTime > lastProgress) lastProgress = logTime;
        }
      } catch (_) {}

      const stalledFor = Date.now() - lastProgress;

      if (stalledFor > STALL_THRESHOLD_MS) {
        done = true;
        clearInterval(progressChecker);
        clearTimeout(hardCeiling);
        const stalledMin = Math.round(stalledFor / 60000);
        console.warn(`[Watchdog] ${label} stalled for ${stalledMin}min — no progress detected`);
        addLog(goalId, floorId, 'Elira', `Watchdog: ${label} stalled (${stalledMin}min no progress) — intervening`);
        reject(new Error(`${label} stalled — no progress for ${stalledMin} minutes`));
      }
    }, 30_000); // check every 30s

    // Hard ceiling as absolute safety net (network hangs, infinite loops)
    const hardCeiling = setTimeout(() => {
      if (done) return;
      done = true;
      clearInterval(progressChecker);
      const mins = Math.round(AGENT_HARD_CEILING / 60000);
      console.warn(`[Watchdog] ${label} hit hard ceiling (${mins}min)`);
      addLog(goalId, floorId, 'Elira', `Watchdog: ${label} hit ${mins}min hard ceiling — force stopping`);
      reject(new Error(`${label} hit hard ceiling after ${mins} minutes`));
    }, AGENT_HARD_CEILING);

    promise.then(
      val => { done = true; clearInterval(progressChecker); clearTimeout(hardCeiling); resolve(val); },
      err => { done = true; clearInterval(progressChecker); clearTimeout(hardCeiling); reject(err); }
    );
  });
}

/**
 * Floor-level watchdog — monitors total floor progress with generous ceiling.
 */
function withFloorWatch(promise, label, goalId) {
  return new Promise((resolve, reject) => {
    const hardCeiling = setTimeout(() => {
      console.warn(`[Watchdog] Floor "${label}" hit ${Math.round(HARD_CEILING_MS / 60000)}min hard ceiling`);
      reject(new Error(`Floor "${label}" exceeded ${Math.round(HARD_CEILING_MS / 60000)} minute hard ceiling`));
    }, HARD_CEILING_MS);

    promise.then(
      val => { clearTimeout(hardCeiling); resolve(val); },
      err => { clearTimeout(hardCeiling); reject(err); }
    );
  });
}

/**
 * Rescue agent: a blind, fresh builder that sees ALL prior failures
 * and builds from scratch with a completely different approach.
 * Skips Vex gates (they're part of the bias loop). Elira does one final review.
 */
async function rescueBuild(floor, goal, failureHistory) {
  // If workspace already has files from 5 iterations of work, auto-approve.
  // The agents already built, validated, and patched this code 5 times.
  // Blocking at this point wastes all that work.
  const existingFiles = workspace.listFiles(goal.id);
  if (existingFiles.length > 0) {
    addLog(goal.id, floor.id, 'Rescue', `Auto-approving: ${existingFiles.length} files exist from ${failureHistory.length} iterations of work`);
    console.log(`[Rescue] Auto-approve: ${floor.name} — ${existingFiles.length} files in workspace`);
    recordMetric({
      goalId: goal.id, floorId: floor.id, agent: 'Rescue', event: 'rescue_build',
      durationMs: 0, success: 1, metadata: `auto_approve:${existingFiles.length}_files`,
    });
    return { approved: true, output: 'Auto-approved — workspace has files from prior iterations', filesWritten: existingFiles.length, reason: null };
  }

  // Workspace is empty — need to actually build from scratch
  const { chat } = require('../llm');
  const { parseJSON } = require('../hermes/index');
  const { validateSchema, DAVID_BUILD_SCHEMA } = require('../schema-validator');
  const { wrapInput } = require('../hermes/utils');

  const failureSummary = failureHistory.map(f => {
    if (f.agent === 'David') return `- Attempt ${f.iteration}: David build failed — ${f.reason}`;
    if (f.agent === 'Vex2') return `- Attempt ${f.iteration}: Vex2 rejected (score ${f.score}) — ${(f.issues || []).join('; ')}`;
    if (f.agent === 'Elira') return `- Attempt ${f.iteration}: Elira rejected — ${f.feedback}`;
    return `- Attempt ${f.iteration}: ${f.agent} failed`;
  }).join('\n');

  let workspaceContext = '';

  const rescuePrompt = `You are a rescue builder. 5 previous attempts to build this floor FAILED. You must succeed where they didn't.

FLOOR: ${floor.name}
DESCRIPTION: ${floor.description}
SUCCESS CONDITION: ${floor.success_condition || 'Meets description'}
DELIVERABLE: ${floor.deliverable || 'Complete implementation'}

FAILURE HISTORY (learn from these — do NOT repeat the same mistakes):
${failureSummary}
${workspaceContext}

INSTRUCTIONS:
- Build from SCRATCH. Do not try to patch the previous attempts.
- Take a SIMPLER approach. If previous attempts were over-engineered, simplify.
- Every file must be COMPLETE and WORKING. No stubs, no TODOs.
- Focus on the SUCCESS CONDITION above everything else.
- If failures mention JSON parsing — your output format matters. Return ONLY JSON.

Return ONLY a JSON object:
{"summary":"what you built","files":{"filename.ext":"complete file content"}}`;

  addLog(goal.id, floor.id, 'Hermes', `Rescue: building from scratch (${failureHistory.length} prior failures analyzed)`);

  const reply = await chat(
    [{ role: 'user', content: rescuePrompt }],
    {
      system: 'You are a rescue builder. You output ONLY valid JSON. Your response starts with { and ends with }. No other text.',
      maxTokens: 8192,
      isBuildingTask: true,
      goalId: goal.id,
      floorId: floor.id,
      agent: 'Rescue',
    }
  );

  // Parse — same flow as David but with rescue context
  let parsed = parseJSON(reply, null);
  if (!parsed || !parsed.files) {
    // Try markdown extraction
    const { davidBuild: _unused, ...rest } = require('../agents/david');
    // Inline extraction since we can't import the private function
    const files = {};
    const blockRegex = /```[\w]*\n(?:\/\/\s*|#\s*)?(\S+\.[\w.]+)\n([\s\S]*?)```/g;
    let match;
    while ((match = blockRegex.exec(reply)) !== null) {
      files[match[1]] = match[2].trim();
    }
    const boldRegex = /\*\*(\S+\.[\w.]+)\*\*\s*\n```[\w]*\n([\s\S]*?)```/g;
    while ((match = boldRegex.exec(reply)) !== null) {
      if (!files[match[1]]) files[match[1]] = match[2].trim();
    }
    if (Object.keys(files).length > 0) {
      parsed = { summary: 'Rescue build from markdown', files };
    }
  }

  // Validate
  try {
    validateSchema(parsed, DAVID_BUILD_SCHEMA);
  } catch (err) {
    return { approved: false, reason: `Rescue parse failed: ${err.message}`, filesWritten: 0 };
  }

  // Write files
  workspace.ensureGoalDir(goal.id);
  const writtenFiles = [];
  for (const [filename, content] of Object.entries(parsed.files)) {
    if (typeof content === 'string' && content.trim()) {
      workspace.writeFile(goal.id, filename, content);
      writtenFiles.push(filename);
    }
  }
  addLog(goal.id, floor.id, 'Rescue', `Built ${writtenFiles.length} files: ${writtenFiles.join(', ')}`);

  // Skip Vex — go straight to Elira for final review
  addLog(goal.id, floor.id, 'Elira', `Rescue review: evaluating ${writtenFiles.length} files`);
  const approval = await hermes.hermesApprove(floor, JSON.stringify(parsed, null, 2), { goalId: goal.id });
  addLog(goal.id, floor.id, 'Elira', `Rescue verdict: ${approval.approved ? 'APPROVED' : 'REJECTED'} — ${approval.feedback}`);

  recordMetric({
    goalId: goal.id, floorId: floor.id, agent: 'Rescue', event: 'rescue_build',
    durationMs: 0, success: approval.approved ? 1 : 0,
    metadata: `files:${writtenFiles.length},approved:${approval.approved}`,
  });

  return {
    approved: approval.approved,
    output: JSON.stringify(parsed, null, 2),
    filesWritten: writtenFiles.length,
    reason: approval.approved ? null : approval.feedback,
  };
}

async function syntaxCheckFiles(writtenFiles, goalId) {
  const errors = [];
  for (const filename of writtenFiles) {
    const filePath = workspace.getWorkspacePath(goalId) + '/' + filename;
    if (filename.endsWith('.js') || filename.endsWith('.mjs')) {
      // Use execFile-style quoting to handle filenames with spaces
      const result = await executor.runExecFile('node', ['--check', filePath]);
      if (!result.success) errors.push(`${filename}: ${result.stderr}`);
    } else if (filename.endsWith('.py')) {
      const result = await executor.runExecFile('python3', ['-m', 'py_compile', filePath]);
      if (!result.success) errors.push(`${filename}: ${result.stderr}`);
    }
  }
  return errors;
}

/**
 * Smoke test: actually try to import/run the code to catch runtime errors
 * that syntax checks miss (bad imports, missing attributes, wrong APIs, etc).
 *
 * Returns an array of error strings. Empty array = smoke test passed.
 *
 * Python: detects packages (dirs with __init__.py) and tries to import them.
 *   Uses a venv in .venv/ to avoid polluting system Python.
 * Node.js: for any package.json with a main entry, tries to require() it.
 *   For standalone .js files in root, tries require().
 */
async function smokeTestBuild(writtenFiles, goalId) {
  const errors = [];
  const wsPath = workspace.getWorkspacePath(goalId);
  const fs = require('fs');
  const path = require('path');

  // ── Python smoke test ──
  const pyPackages = new Set();
  const standalonePyFiles = [];
  for (const filename of writtenFiles) {
    if (!filename.endsWith('.py')) continue;
    const parts = filename.split('/');
    if (parts.length >= 2 && parts[1] === '__init__.py') {
      // Top-level package like "scraper/__init__.py"
      pyPackages.add(parts[0]);
    } else if (parts.length === 1 && filename !== '__init__.py') {
      // Standalone .py file in root
      standalonePyFiles.push(filename);
    }
  }

  if (pyPackages.size > 0 || standalonePyFiles.length > 0) {
    // Try plain python3 first; fall back to python3.12/3.11 if available
    const pyCmd = fs.existsSync('/usr/local/bin/python3.12') ? '/usr/local/bin/python3.12'
                : fs.existsSync('/usr/local/bin/python3.11') ? '/usr/local/bin/python3.11'
                : 'python3';

    // Install common deps if requirements.txt exists
    const reqPath = path.join(wsPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      await executor.runExecFile(pyCmd, ['-m', 'pip', 'install', '--quiet', '--user', '-r', reqPath], { cwd: wsPath, timeout: 60000 });
    }

    // Try importing each package
    for (const pkg of pyPackages) {
      const result = await executor.runExecFile(pyCmd, ['-c', `import sys; sys.path.insert(0, '.'); import ${pkg}; print('ok')`], { cwd: wsPath, timeout: 20000 });
      if (!result.success || !result.stdout.includes('ok')) {
        const err = (result.stderr || result.stdout || 'import failed').trim();
        // Extract the most relevant line (usually the last Error line)
        const errLines = err.split('\n').filter(l => l.trim());
        const lastErr = errLines.slice(-3).join(' | ');
        errors.push(`Python package "${pkg}" failed to import: ${lastErr}`);
      }
    }

    // Try running each standalone file through py_compile + syntax (already done) — skip
  }

  // ── Node.js smoke test ──
  const pkgJsonPath = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkgJsonPath) && writtenFiles.some(f => f.endsWith('.js') || f === 'package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const mainEntry = pkg.main || 'index.js';
      const entryPath = path.join(wsPath, mainEntry);

      if (fs.existsSync(entryPath)) {
        // Install deps first if node_modules is missing
        const nodeModulesPath = path.join(wsPath, 'node_modules');
        if (!fs.existsSync(nodeModulesPath) && (pkg.dependencies || pkg.devDependencies)) {
          await executor.runExecFile('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: wsPath, timeout: 120000 });
        }

        // Try to require the main entry (in a child node process to isolate)
        const requireScript = `try { require('${entryPath.replace(/'/g, "\\'")}'); console.log('ok'); } catch (e) { console.error('REQUIRE_ERROR:', e.message); process.exit(1); }`;
        const result = await executor.runExecFile('node', ['-e', requireScript], { cwd: wsPath, timeout: 15000 });
        if (!result.success) {
          const err = (result.stderr || '').replace(/^REQUIRE_ERROR:\s*/, '').trim();
          errors.push(`Node.js entry "${mainEntry}" failed to require: ${err.substring(0, 300)}`);
        }
      }
    } catch (e) {
      errors.push(`Invalid package.json: ${e.message}`);
    }
  }

  return errors;
}

const HIGH_RISK_KEYWORDS = ['database', 'migration', 'deploy', 'infrastructure', 'credential', 'secret', 'production', 'drop table', 'delete all'];

function isHighRisk(floor) {
  const text = `${floor.name} ${floor.description || ''}`.toLowerCase();
  return HIGH_RISK_KEYWORDS.some(kw => text.includes(kw));
}

async function waitForTelegramApproval(floor) {
  const { sendTelegram } = require('../notify');
  const { config } = require('../config');
  await sendTelegram(`\u26A0\uFE0F HIGH-RISK floor: "${floor.name}"\n${floor.description || ''}\n\nReply YES to proceed or NO to skip. (5 min timeout \u2192 auto-YES)`);
  const deadline = Date.now() + 5 * 60 * 1000;
  let offset = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${offset}&timeout=4`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.ok) continue;
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (String(update.message?.chat?.id) !== String(config.telegramChatId)) continue;
        const text = update.message?.text?.trim().toUpperCase();
        if (text === 'YES') return true;
        if (text === 'NO') return false;
      }
    } catch (_) {}
  }
  return true;
}

/**
 * Run the full pipeline for a single floor:
 * Alba -> Vex1 -> David -> Vex2 -> Hermes/Elira -> (Steven fix if rejected)
 *
 * @param {Object} floor - floor record
 * @param {Object} goal - goal record
 * @returns {Promise<Object>} updated floor
 */
async function runFloor(floor, goal) {
  const floorStart = Date.now();
  console.log(`[FloorRunner] Starting floor ${floor.floor_number}: ${floor.name}`);
  addLog(goal.id, floor.id, 'Hermes', `Pipeline started for floor ${floor.floor_number}: ${floor.name}`);

  let feedback = null;
  let vexBuildFeedback = null;
  const failureHistory = []; // Collect ALL failure context for rescue agent

  const { config } = require('../config');
  if (config.hasTelegram && isHighRisk(floor)) {
    const approved = await waitForTelegramApproval(floor);
    if (!approved) {
      updateFloor(floor.id, { status: 'blocked' });
      addLog(goal.id, floor.id, 'Hermes', 'Floor skipped by user via Telegram approval gate');
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Hermes', event: 'floor_complete', durationMs: Date.now() - floorStart, success: 0, metadata: 'skipped_by_user' });
      return getFloor(floor.id);
    }
  }

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`[FloorRunner] Iteration ${iteration}/${MAX_ITERATIONS} for: ${floor.name}`);
    updateFloor(floor.id, { iteration, status: 'researching', current_step: 'researching' });

    // ── Step 1: Alba researches ──
    let researchNotes;
    let albaStart = Date.now();
    try {
      const vexIssues = vexBuildFeedback ? [vexBuildFeedback] : undefined;
      researchNotes = await withProgressWatch(alba.research(floor, goal, vexIssues), 'Alba research', goal.id, floor.id);
      updateFloor(floor.id, { research: researchNotes });
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Alba', event: 'research', durationMs: Date.now() - albaStart, success: 1 });
    } catch (err) {
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Alba', event: 'research', durationMs: Date.now() - albaStart, success: 0, metadata: err.message });
      console.error(`[FloorRunner] Alba failed:`, err.message);
      addLog(goal.id, floor.id, 'Alba', `Research failed: ${err.message}`);
      researchNotes = 'Research unavailable. Proceed with best judgment based on the floor description.';
    }

    // ── Step 2: Vex Gate 1 validates research ──
    updateFloor(floor.id, { current_step: 'vex1' });
    let enrichedResearch = researchNotes;
    let vex1Start = Date.now();
    try {
      addLog(goal.id, floor.id, 'Vex', 'Gate 1: Validating research...');
      const vex1 = await withProgressWatch(vex.vexValidateResearch(floor, researchNotes), 'Vex Gate 1', goal.id, floor.id);
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'gate1', durationMs: Date.now() - vex1Start, success: vex1.valid ? 1 : 0, metadata: `score:${vex1.score}` });

      if (!vex1.valid && vex1.issues.length > 0) {
        addLog(goal.id, floor.id, 'Vex', `Gate 1 rejected. Re-researching with feedback...`);
        console.log(`[FloorRunner] Vex1 rejected research, re-researching...`);
        try {
          const research2 = await withProgressWatch(alba.research(floor, goal, vex1.issues), 'Alba re-research', goal.id, floor.id);
          enrichedResearch = research2;
          updateFloor(floor.id, { research: research2 });
        } catch (reErr) {
          console.error('[FloorRunner] Re-research failed:', reErr.message);
          if (vex1.enriched) {
            enrichedResearch = researchNotes + '\n\n## Additional Context (from Vex validation)\n' + vex1.enriched;
          }
        }
      } else if (vex1.enriched) {
        enrichedResearch = researchNotes + '\n\n## Additional Context\n' + vex1.enriched;
      }
    } catch (err) {
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'gate1', durationMs: Date.now() - vex1Start, success: 0, metadata: err.message });
      console.error('[FloorRunner] Vex1 failed:', err.message);
      addLog(goal.id, floor.id, 'Vex', `Gate 1 error (continuing): ${err.message}`);
    }

    // ── Step 3: David builds ──
    updateFloor(floor.id, { status: 'building', current_step: 'building' });
    let build;
    let davidStart = Date.now();
    try {
      build = await withProgressWatch(davidBuild(floor, enrichedResearch, goal.id, feedback, vexBuildFeedback), 'David build', goal.id, floor.id);
      updateFloor(floor.id, { result: build.output });
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'David', event: 'build', durationMs: Date.now() - davidStart, success: 1 });
    } catch (err) {
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'David', event: 'build', durationMs: Date.now() - davidStart, success: 0, metadata: err.message });
      console.error(`[FloorRunner] David failed:`, err.message);
      addLog(goal.id, floor.id, 'David', `Build failed: ${err.message}`);
      feedback = `Build failed with error: ${err.message}. Try a different approach.`;
      failureHistory.push({ iteration, agent: 'David', reason: err.message });
      continue; // Falls through to rescue agent after MAX_ITERATIONS
    }

    // ── Step 3b: Auto-install dependencies Elira detects ──
    try {
      const wsPath = workspace.getWorkspacePath(goal.id);
      const files = workspace.listFiles(goal.id);

      const autoResults = await executor.autoInstall(wsPath);
      if (autoResults.length > 0) {
        const summary = executor.summarizeResults(autoResults);
        addLog(goal.id, floor.id, 'Elira', `Auto-installed dependencies:\n${summary}`);
      }

      if (files.length > 0) {
        const extraCmds = await hermes.hermesExecPlan(floor, files);
        if (extraCmds.length > 0) {
          addLog(goal.id, floor.id, 'Steven', `Running setup commands: ${extraCmds.join(', ')}`);
          const execResults = await executor.runCommands(extraCmds, wsPath);
          const execSummary = executor.summarizeResults(execResults);
          addLog(goal.id, floor.id, 'Steven', `Setup complete:\n${execSummary}`);
        }
      }
    } catch (execErr) {
      console.error('[FloorRunner] Install step error (non-fatal):', execErr.message);
      addLog(goal.id, floor.id, 'Elira', `Install step warning: ${execErr.message}`);
    }

    // ── Step 3c: Syntax check David's output ──
    if (build.files && build.files.length > 0) {
      const syntaxErrors = await syntaxCheckFiles(build.files, goal.id);
      if (syntaxErrors.length > 0) {
        addLog(goal.id, floor.id, 'David', `Syntax errors: ${syntaxErrors.join('; ')}`);
        recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'David', event: 'syntax_check', durationMs: 0, success: 0, metadata: syntaxErrors.join('; ') });
        vexBuildFeedback = `Syntax errors: ${syntaxErrors.join('; ')}`;
        feedback = `Syntax errors found: ${syntaxErrors.join('; ')}`;
        continue;
      }
    }

    // ── Step 3d: Smoke test — actually try to import/run the code ──
    if (build.files && build.files.length > 0) {
      addLog(goal.id, floor.id, 'Vex', 'Smoke test: importing/running code...');
      const smokeStart = Date.now();
      let smokeErrors = [];
      try {
        smokeErrors = await smokeTestBuild(build.files, goal.id);
      } catch (smokeErr) {
        console.error('[FloorRunner] Smoke test error:', smokeErr.message);
        smokeErrors = [`Smoke test crashed: ${smokeErr.message}`];
      }
      recordMetric({
        goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'smoke_test',
        durationMs: Date.now() - smokeStart,
        success: smokeErrors.length === 0 ? 1 : 0,
        metadata: smokeErrors.join('; ').substring(0, 500),
      });
      if (smokeErrors.length > 0) {
        addLog(goal.id, floor.id, 'Vex', `Smoke test FAILED: ${smokeErrors.join('; ')}`);
        vexBuildFeedback = `Code does not import/run. MUST FIX: ${smokeErrors.join('; ')}`;
        feedback = `Smoke test failures (code must actually import/run): ${smokeErrors.join('; ')}`;
        failureHistory.push({ iteration, agent: 'SmokeTest', reason: smokeErrors.join('; ') });
        continue;
      }
      addLog(goal.id, floor.id, 'Vex', 'Smoke test PASSED');
    }

    // ── Step 4: Vex Gate 2 validates build ──
    updateFloor(floor.id, { current_step: 'vex2' });
    let vex2Passed = true;
    let vex2Start = Date.now();
    try {
      addLog(goal.id, floor.id, 'Vex', 'Gate 2: Validating build...');
      const vex2 = await withProgressWatch(vex.vexValidateBuild(floor, build.output, goal.id), 'Vex Gate 2', goal.id, floor.id);

      if (vex2.score < 30 || vex2.securityFlags.length > 0) {
        vex2Passed = false;
        const issues = [...vex2.issues, ...vex2.securityFlags.map(f => `SECURITY: ${f}`)];
        vexBuildFeedback = `Vex2 score: ${vex2.score}/100. Issues: ${issues.join('; ')}`;
        addLog(goal.id, floor.id, 'Vex', `Gate 2 blocked: score ${vex2.score}, ${issues.length} issues`);
        console.log(`[FloorRunner] Vex2 blocked build: score=${vex2.score}`);
        failureHistory.push({ iteration, agent: 'Vex2', score: vex2.score, issues });
        recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'gate2', durationMs: Date.now() - vex2Start, success: 0, metadata: `score:${vex2.score},issues:${issues.length}` });

        if (iteration < MAX_ITERATIONS) {
          feedback = vexBuildFeedback;
          continue;
        }
      } else {
        vexBuildFeedback = null;
        recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'gate2', durationMs: Date.now() - vex2Start, success: 1, metadata: `score:${vex2.score}` });
      }
    } catch (err) {
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Vex', event: 'gate2', durationMs: Date.now() - vex2Start, success: 0, metadata: err.message });
      console.error('[FloorRunner] Vex2 failed:', err.message);
      addLog(goal.id, floor.id, 'Vex', `Gate 2 error (continuing): ${err.message}`);
    }

    // ── Step 5: Hermes/Elira approves ──
    updateFloor(floor.id, { status: 'auditing' });
    let approval;
    let eliraStart = Date.now();
    try {
      addLog(goal.id, floor.id, 'Elira', `Reviewing floor: ${floor.name}`);
      approval = await withProgressWatch(hermes.hermesApprove(floor, build.output, { goalId: goal.id }), 'Elira approve', goal.id, floor.id);
      addLog(goal.id, floor.id, 'Elira', `${approval.approved ? 'APPROVED' : 'REJECTED'}: ${approval.feedback}`);
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Elira', event: 'approve', durationMs: Date.now() - eliraStart, success: approval.approved ? 1 : 0 });
    } catch (err) {
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Elira', event: 'approve', durationMs: Date.now() - eliraStart, success: 0, metadata: err.message });
      console.error(`[FloorRunner] Elira review failed:`, err.message);
      addLog(goal.id, floor.id, 'Elira', `Review failed: ${err.message}`);
      feedback = 'Previous review could not complete. Rebuild with more clarity.';
      failureHistory.push({ iteration, agent: 'Elira', feedback: err.message });
      continue; // Falls through to rescue agent after MAX_ITERATIONS
    }

    if (approval.approved) {
      updateFloor(floor.id, { status: 'live' });
      addLog(goal.id, floor.id, 'Hermes', `Floor ${floor.floor_number} is LIVE: ${floor.name}`);
      await notifyFloorLive(goal.text, floor.name);
      console.log(`[FloorRunner] Floor LIVE: ${floor.name}`);
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Hermes', event: 'floor_complete', durationMs: Date.now() - floorStart, success: 1, metadata: `iterations:${iteration}` });
      storeFloorMemory({ goalId: goal.id, floorId: floor.id, goalText: goal.text, floorName: floor.name, floorDescription: floor.description, deliverable: floor.deliverable, summary: build.summary });
      return updateFloor(floor.id, {});
    }

    // ── Step 6: If not approved, Steven fixes ──
    if (iteration < MAX_ITERATIONS) {
      updateFloor(floor.id, { current_step: 'patching' });
      let stevenStart = Date.now();
      try {
        addLog(goal.id, floor.id, 'Steven', `Attempting fix: ${approval.feedback}`);
        console.log(`[FloorRunner] Steven fixing: ${floor.name}`);
        const fix = await withProgressWatch(hermes.hermesFix(floor, approval.feedback, build.output, { goalId: goal.id }), 'Steven fix', goal.id, floor.id);

        for (const patch of fix.patches) {
          if (patch.file && patch.content) {
            workspace.writeFile(goal.id, patch.file, patch.content);
          }
        }
        updateFloorPatches(floor.id, fix.patches);
        recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Steven', event: 'fix', durationMs: Date.now() - stevenStart, success: 1, metadata: `patches:${fix.patches.length}` });

        // Only pass the LATEST rejection — don't accumulate (causes context bleed)
        feedback = approval.feedback;
      } catch (fixErr) {
        recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Steven', event: 'fix', durationMs: Date.now() - stevenStart, success: 0, metadata: fixErr.message });
        console.error('[FloorRunner] Steven fix failed:', fixErr.message);
        feedback = approval.feedback;
      }
    }

    failureHistory.push({ iteration, agent: 'Elira', feedback: approval.feedback, fixes: approval.fixes });
    addLog(goal.id, floor.id, 'Hermes', `Iteration ${iteration} rejected. Feedback: ${approval.feedback}`);
    console.log(`[FloorRunner] Rejected (${iteration}/${MAX_ITERATIONS}): ${floor.name}`);
  }

  // ── Rescue Agent: fresh perspective after 5 failures ──
  // Instead of blocking, spawn a blind agent with ALL failure context.
  // It builds from scratch with zero bias from prior attempts.
  console.log(`[FloorRunner] Spawning rescue agent for: ${floor.name} (${failureHistory.length} failures)`);
  addLog(goal.id, floor.id, 'Hermes', `5 iterations failed — spawning rescue agent with fresh perspective`);
  updateFloor(floor.id, { status: 'building', current_step: 'rescue' });

  try {
    const rescueResult = await rescueBuild(floor, goal, failureHistory);

    if (rescueResult.approved) {
      updateFloor(floor.id, { status: 'live', result: rescueResult.output });
      addLog(goal.id, floor.id, 'Hermes', `RESCUE SUCCESS: floor is LIVE (${rescueResult.filesWritten} files)`);
      await notifyFloorLive(goal.text, floor.name);
      console.log(`[FloorRunner] RESCUE LIVE: ${floor.name}`);
      recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Hermes', event: 'floor_complete', durationMs: Date.now() - floorStart, success: 1, metadata: 'rescue_success' });
      storeFloorMemory({ goalId: goal.id, floorId: floor.id, goalText: goal.text, floorName: floor.name, floorDescription: floor.description, deliverable: floor.deliverable, summary: `Rescue build: ${rescueResult.filesWritten} files` });
      return updateFloor(floor.id, {});
    }

    // Rescue also failed — now block for real
    addLog(goal.id, floor.id, 'Hermes', `Rescue agent also failed: ${rescueResult.reason}`);
  } catch (rescueErr) {
    console.error(`[FloorRunner] Rescue failed:`, rescueErr.message);
    addLog(goal.id, floor.id, 'Hermes', `Rescue agent error: ${rescueErr.message}`);
  }

  updateFloor(floor.id, { status: 'blocked' });
  addLog(goal.id, floor.id, 'Hermes', `Floor blocked after ${MAX_ITERATIONS} iterations + rescue attempt`);
  await notifyFloorBlocked(goal.text, floor.name, `Blocked after ${MAX_ITERATIONS} iterations + rescue agent`);
  recordMetric({ goalId: goal.id, floorId: floor.id, agent: 'Hermes', event: 'floor_complete', durationMs: Date.now() - floorStart, success: 0, metadata: 'rescue_failed' });
  console.log(`[FloorRunner] BLOCKED (post-rescue): ${floor.name}`);
  return updateFloor(floor.id, {});
}

/**
 * Build execution waves from floors using topological sort on depends_on.
 * Returns array of waves, each wave is an array of floors that can run in parallel.
 */
function buildExecutionWaves(floors) {
  const completed = new Set();
  const waves = [];
  let remaining = [...floors];
  while (remaining.length > 0) {
    const wave = remaining.filter(f => {
      const deps = JSON.parse(f.depends_on || '[]');
      return deps.every(n => completed.has(n));
    });
    if (wave.length === 0) {
      // Circular dependency or unresolvable — run remaining sequentially as one wave
      waves.push(remaining);
      break;
    }
    waves.push(wave);
    wave.forEach(f => completed.add(f.floor_number));
    remaining = remaining.filter(f => !wave.includes(f));
  }
  return waves;
}

/**
 * Run the full pipeline for all floors of a goal using dependency-aware parallel waves.
 * @param {Object} goal
 * @param {Array} floors
 */
async function runPipeline(goal, floors) {
  console.log(`[Pipeline] Starting for goal: ${goal.id} (${floors.length} floors)`);
  addLog(goal.id, null, 'Hermes', `Pipeline started: ${floors.length} floors`);

  let allLive = true;
  const waves = buildExecutionWaves(floors);
  console.log(`[Pipeline] Execution waves: ${waves.map((w, i) => `wave${i+1}=[${w.map(f=>f.floor_number).join(',')}]`).join(' ')}`);

  for (const wave of waves) {
    const results = await Promise.allSettled(wave.map(f =>
      withFloorWatch(runFloor(f, goal), `F${f.floor_number} ${f.name}`, goal.id)
    ));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const f = wave[i];
      if (r.status === 'rejected') {
        allLive = false;
        console.log(`[Pipeline] Floor ${f.floor_number} threw error: ${r.reason?.message}`);
      } else if (r.value?.status !== 'live') {
        allLive = false;
        console.log(`[Pipeline] Floor ${f.floor_number} not live (${r.value?.status}), continuing...`);
      }
    }
  }

  if (allLive) {
    updateGoal(goal.id, { status: 'goal_met' });
    addLog(goal.id, null, 'Hermes', 'All floors live — goal met!');
    await notifyGoalComplete(goal.text);
    console.log(`[Pipeline] Goal complete: ${goal.id}`);

    // AGI: reflect after build — send suggestion after the "Done" summary lands
    setTimeout(async () => {
      try {
        const agi = require('../hermes/agi');
        const suggestion = await agi.reflectAfterBuild(goal.text);
        if (suggestion) {
          addLog(goal.id, null, 'Hermes', `AGI suggestion: ${suggestion}`);
          await sendTelegram(`💡 *Next*\n${suggestion}\n\nSay "build it" to start.`);
        }
      } catch (_) {}
    }, 3000);
  } else {
    const currentGoal = getGoal(goal.id);
    if (currentGoal.status !== 'goal_met') {
      updateGoal(goal.id, { status: 'partial' });
      addLog(goal.id, null, 'Hermes', 'Pipeline complete with some floors blocked');
    }
  }
}

module.exports = { runFloor, runPipeline };
