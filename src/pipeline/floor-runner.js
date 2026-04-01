const alba = require('../agents/alba');
const { davidBuild } = require('../agents/david');
const vex = require('../agents/vex');
const hermes = require('../hermes/index');
const workspace = require('./workspace');
const executor = require('../executor');
const { updateFloor, addLog, listFloors, updateGoal, getGoal, getFloor, updateFloorPatches } = require('../db');
const { notifyFloorLive, notifyFloorBlocked, notifyGoalComplete, sendTelegram } = require('../notify');

const MAX_ITERATIONS = 3;

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
  console.log(`[FloorRunner] Starting floor ${floor.floor_number}: ${floor.name}`);
  addLog(goal.id, floor.id, 'Hermes', `Pipeline started for floor ${floor.floor_number}: ${floor.name}`);

  let feedback = null;
  let vexBuildFeedback = null;

  const { config } = require('../config');
  if (config.hasTelegram && isHighRisk(floor)) {
    const approved = await waitForTelegramApproval(floor);
    if (!approved) {
      updateFloor(floor.id, { status: 'blocked' });
      addLog(goal.id, floor.id, 'Hermes', 'Floor skipped by user via Telegram approval gate');
      return getFloor(floor.id);
    }
  }

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`[FloorRunner] Iteration ${iteration}/${MAX_ITERATIONS} for: ${floor.name}`);
    updateFloor(floor.id, { iteration, status: 'researching', current_step: 'researching' });

    // ── Step 1: Alba researches ──
    let researchNotes;
    try {
      const vexIssues = vexBuildFeedback ? [vexBuildFeedback] : undefined;
      researchNotes = await alba.research(floor, goal, vexIssues);
      updateFloor(floor.id, { research: researchNotes });
    } catch (err) {
      console.error(`[FloorRunner] Alba failed:`, err.message);
      addLog(goal.id, floor.id, 'Alba', `Research failed: ${err.message}`);
      researchNotes = 'Research unavailable. Proceed with best judgment based on the floor description.';
    }

    // ── Step 2: Vex Gate 1 validates research ──
    updateFloor(floor.id, { current_step: 'vex1' });
    let enrichedResearch = researchNotes;
    try {
      addLog(goal.id, floor.id, 'Vex', 'Gate 1: Validating research...');
      const vex1 = await vex.vexValidateResearch(floor, researchNotes);

      if (!vex1.valid && vex1.issues.length > 0) {
        // Re-research with Vex's feedback
        addLog(goal.id, floor.id, 'Vex', `Gate 1 rejected. Re-researching with feedback...`);
        console.log(`[FloorRunner] Vex1 rejected research, re-researching...`);
        try {
          const research2 = await alba.research(floor, goal, vex1.issues);
          enrichedResearch = research2;
          updateFloor(floor.id, { research: research2 });
        } catch (reErr) {
          console.error('[FloorRunner] Re-research failed:', reErr.message);
          // Continue with original research + enriched notes
          if (vex1.enriched) {
            enrichedResearch = researchNotes + '\n\n## Additional Context (from Vex validation)\n' + vex1.enriched;
          }
        }
      } else if (vex1.enriched) {
        enrichedResearch = researchNotes + '\n\n## Additional Context\n' + vex1.enriched;
      }
    } catch (err) {
      console.error('[FloorRunner] Vex1 failed:', err.message);
      addLog(goal.id, floor.id, 'Vex', `Gate 1 error (continuing): ${err.message}`);
      // Continue without Vex1 — don't block on validator failure
    }

    // ── Step 3: David builds ──
    updateFloor(floor.id, { status: 'building', current_step: 'building' });
    let build;
    try {
      build = await davidBuild(floor, enrichedResearch, goal.id, feedback, vexBuildFeedback);
      updateFloor(floor.id, { result: build.output });
    } catch (err) {
      console.error(`[FloorRunner] David failed:`, err.message);
      addLog(goal.id, floor.id, 'David', `Build failed: ${err.message}`);
      if (iteration === MAX_ITERATIONS) {
        updateFloor(floor.id, { status: 'blocked' });
        await notifyFloorBlocked(goal.text, floor.name, `David failed: ${err.message}`);
        return updateFloor(floor.id, {});
      }
      feedback = `Build failed with error: ${err.message}. Try a different approach.`;
      continue;
    }

    // ── Step 3b: Auto-install dependencies Elira detects ──
    try {
      const wsPath = workspace.getWorkspacePath(goal.id);
      const files = workspace.listFiles(goal.id);

      // Auto-install from requirements.txt / package.json
      const autoResults = await executor.autoInstall(wsPath);
      if (autoResults.length > 0) {
        const summary = executor.summarizeResults(autoResults);
        addLog(goal.id, floor.id, 'Elira', `Auto-installed dependencies:\n${summary}`);
      }

      // Ask Hermes/Steven if any extra commands are needed
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

    // ── Step 4: Vex Gate 2 validates build ──
    updateFloor(floor.id, { current_step: 'vex2' });
    let vex2Passed = true;
    try {
      addLog(goal.id, floor.id, 'Vex', 'Gate 2: Validating build...');
      const vex2 = await vex.vexValidateBuild(floor, build.output, goal.id);

      if (vex2.score < 60 || vex2.securityFlags.length > 0) {
        vex2Passed = false;
        const issues = [...vex2.issues, ...vex2.securityFlags.map(f => `SECURITY: ${f}`)];
        vexBuildFeedback = `Vex2 score: ${vex2.score}/100. Issues: ${issues.join('; ')}`;
        addLog(goal.id, floor.id, 'Vex', `Gate 2 blocked: score ${vex2.score}, ${issues.length} issues`);
        console.log(`[FloorRunner] Vex2 blocked build: score=${vex2.score}`);

        if (iteration === MAX_ITERATIONS) {
          // Last iteration — try to pass through to Elira anyway
          addLog(goal.id, floor.id, 'Vex', 'Gate 2 failed on final iteration — escalating to Elira');
          vex2Passed = true; // Let Elira decide
        } else {
          // Rebuild with Vex2 feedback
          feedback = vexBuildFeedback;
          continue;
        }
      } else {
        vexBuildFeedback = null;
      }
    } catch (err) {
      console.error('[FloorRunner] Vex2 failed:', err.message);
      addLog(goal.id, floor.id, 'Vex', `Gate 2 error (continuing): ${err.message}`);
      // Continue without Vex2
    }

    // ── Step 5: Hermes/Elira approves ──
    updateFloor(floor.id, { status: 'auditing' });
    let approval;
    try {
      addLog(goal.id, floor.id, 'Elira', `Reviewing floor: ${floor.name}`);
      approval = await hermes.hermesApprove(floor, build.output, { goalId: goal.id });
      addLog(goal.id, floor.id, 'Elira', `${approval.approved ? 'APPROVED' : 'REJECTED'}: ${approval.feedback}`);
    } catch (err) {
      console.error(`[FloorRunner] Elira review failed:`, err.message);
      addLog(goal.id, floor.id, 'Elira', `Review failed: ${err.message}`);
      if (iteration === MAX_ITERATIONS) {
        updateFloor(floor.id, { status: 'blocked' });
        await notifyFloorBlocked(goal.text, floor.name, `Review failed: ${err.message}`);
        return updateFloor(floor.id, {});
      }
      feedback = 'Previous review could not complete. Rebuild with more clarity.';
      continue;
    }

    if (approval.approved) {
      updateFloor(floor.id, { status: 'live' });
      addLog(goal.id, floor.id, 'Hermes', `Floor ${floor.floor_number} is LIVE: ${floor.name}`);
      await notifyFloorLive(goal.text, floor.name);
      console.log(`[FloorRunner] Floor LIVE: ${floor.name}`);
      return updateFloor(floor.id, {});
    }

    // ── Step 6: If not approved, Steven fixes ──
    if (iteration < MAX_ITERATIONS) {
      updateFloor(floor.id, { current_step: 'patching' });
      try {
        addLog(goal.id, floor.id, 'Steven', `Attempting fix: ${approval.feedback}`);
        console.log(`[FloorRunner] Steven fixing: ${floor.name}`);
        const fix = await hermes.hermesFix(floor, approval.feedback, build.output, { goalId: goal.id });

        // Apply patches to workspace
        for (const patch of fix.patches) {
          if (patch.file && patch.content) {
            workspace.writeFile(goal.id, patch.file, patch.content);
          }
        }
        updateFloorPatches(floor.id, fix.patches);

        feedback = approval.feedback + (fix.fixPlan.length > 0 ? '\n\nSteven fix plan: ' + fix.fixPlan.join(', ') : '');
      } catch (fixErr) {
        console.error('[FloorRunner] Steven fix failed:', fixErr.message);
        feedback = approval.feedback;
      }
    }

    addLog(goal.id, floor.id, 'Hermes', `Iteration ${iteration} rejected. Feedback: ${approval.feedback}`);
    console.log(`[FloorRunner] Rejected (${iteration}/${MAX_ITERATIONS}): ${floor.name}`);
  }

  // Max iterations reached
  updateFloor(floor.id, { status: 'blocked' });
  addLog(goal.id, floor.id, 'Hermes', `Floor blocked after ${MAX_ITERATIONS} iterations`);
  await notifyFloorBlocked(goal.text, floor.name, `Max iterations (${MAX_ITERATIONS}) reached`);
  console.log(`[FloorRunner] BLOCKED: ${floor.name}`);
  return updateFloor(floor.id, {});
}

/**
 * Run the full pipeline for all floors of a goal sequentially.
 * @param {Object} goal
 * @param {Array} floors
 */
async function runPipeline(goal, floors) {
  console.log(`[Pipeline] Starting for goal: ${goal.id} (${floors.length} floors)`);
  addLog(goal.id, null, 'Hermes', `Pipeline started: ${floors.length} floors`);

  let allLive = true;

  for (const floor of floors) {
    const result = await runFloor(floor, goal);
    if (result.status !== 'live') {
      allLive = false;
      console.log(`[Pipeline] Floor ${floor.floor_number} not live (${result.status}), continuing...`);
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
