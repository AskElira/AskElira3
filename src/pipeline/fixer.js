const { hermesFix, hermesReason, hermesExecPlan } = require('../hermes/index');
const { vexValidateBuild } = require('../agents/vex');
const workspace = require('./workspace');
const executor = require('../executor');
const { getFloor, getGoal, updateFloor, updateFloorPatches, listLiveFloors, addLog } = require('../db');
const { sendTelegram, notifyStevenAlert } = require('../notify');

/**
 * Steven's fix engine: diagnose, patch, and validate a broken floor.
 *
 * @param {Object} floor - floor record
 * @param {Object} goal - goal record
 * @param {string} errorReport - what went wrong
 * @returns {Promise<{fixed: boolean, patches: Array, summary: string}>}
 */
async function stevenFix(floor, goal, errorReport) {
  console.log(`[Steven] Fixing floor: ${floor.name}`);
  addLog(goal.id, floor.id, 'Steven', `Starting fix for: ${floor.name}`);

  try {
    // 1. Read current workspace files
    const workspaceSummary = workspace.getWorkspaceSummary(goal.id);

    // 2. Hermes reasons about the error (Steven mode)
    const previousOutput = floor.result || workspaceSummary;
    const fix = await hermesFix(floor, errorReport, previousOutput);

    // 3. Apply patches to workspace
    const appliedPatches = [];
    for (const patch of fix.patches) {
      try {
        if (patch.file && patch.content) {
          workspace.writeFile(goal.id, patch.file, patch.content);
          appliedPatches.push(patch.file);
        }
      } catch (patchErr) {
        console.error(`[Steven] Failed to apply patch ${patch.file}:`, patchErr.message);
      }
    }

    // 4. Save patches to DB
    updateFloorPatches(floor.id, fix.patches);

    // 4b. Run any install/setup commands Steven determines are needed
    const wsPath = workspace.getWorkspacePath(goal.id);
    const wsFiles = workspace.listFiles(goal.id);

    // Auto-install from manifest files
    const autoResults = await executor.autoInstall(wsPath);
    if (autoResults.length > 0) {
      addLog(goal.id, floor.id, 'Steven', `Dependencies installed:\n${executor.summarizeResults(autoResults)}`);
    }

    // Steven plans any extra commands (e.g., if error says "module not found")
    const extraCmds = await hermesExecPlan(floor, wsFiles, errorReport);
    if (extraCmds.length > 0) {
      addLog(goal.id, floor.id, 'Steven', `Running fix commands: ${extraCmds.join(' | ')}`);
      const execResults = await executor.runCommands(extraCmds, wsPath);
      addLog(goal.id, floor.id, 'Steven', executor.summarizeResults(execResults));
    }

    // 5. Vex2 validates the patched code
    const updatedOutput = workspace.getWorkspaceSummary(goal.id);
    const vex2 = await vexValidateBuild(floor, updatedOutput, goal.id);

    const fixed = vex2.valid && vex2.score >= 60;

    // Only log/report if something meaningful happened
    if (appliedPatches.length > 0) {
      const summary = `${fix.diagnosis}. Patches: ${appliedPatches.join(', ')}. Vex2: ${vex2.score}.`;
      addLog(goal.id, floor.id, 'Steven', `Fix ${fixed ? 'OK' : 'incomplete'}: ${summary}`);
      console.log(`[Steven] ${fixed ? 'Fixed' : 'Partial fix'}: ${floor.name} (${appliedPatches.length} patches)`);
    }

    return { fixed, patches: fix.patches, summary: fix.diagnosis || '' };
  } catch (err) {
    console.error(`[Steven] Fix failed for ${floor.name}:`, err.message);
    addLog(goal.id, floor.id, 'Steven', `Fix failed: ${err.message}`);
    return { fixed: false, patches: [], summary: `Fix error: ${err.message}` };
  }
}

// Per-floor cooldown: don't re-check same floor within 1 hour
const floorLastChecked = new Map();

/**
 * Steven's monitor: checks live floors from recent active goals only.
 * Silent on healthy. Only fires Telegram when actually fixing something.
 */
async function stevenMonitor() {
  try {
    const liveFloors = listLiveFloors();
    if (liveFloors.length === 0) return;

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    // Only monitor floors from goals active in the last 24h and not goal_met
    const floorsToCheck = liveFloors.filter(floor => {
      const goal = getGoal(floor.goal_id);
      if (!goal) return false;
      if (goal.status === 'goal_met') return false;
      const goalAge = new Date(goal.created_at * 1000 || goal.created_at).getTime();
      if (goalAge < oneDayAgo) return false;
      // Cooldown: skip if checked recently
      const lastChecked = floorLastChecked.get(floor.id) || 0;
      if (lastChecked > oneHourAgo) return false;
      return true;
    });

    if (floorsToCheck.length === 0) return;
    console.log(`[Steven] Monitor: checking ${floorsToCheck.length} floor(s)`);

    for (const floor of floorsToCheck) {
      try {
        floorLastChecked.set(floor.id, now);
        const goal = getGoal(floor.goal_id);
        if (!goal) continue;

        const files = workspace.listFiles(goal.id);
        const context = `Floor: ${floor.name}\nGoal: ${goal.text.substring(0, 100)}\nFiles: ${files.slice(0, 10).join(', ') || 'none'}\nSuccess condition: ${floor.success_condition || 'meets description'}`;
        const task = 'Is this floor broken or failing? Answer YES or NO only, then one sentence why.';

        const assessment = await hermesReason(context, task);
        const isHealthy = !assessment.toLowerCase().startsWith('yes');

        if (isHealthy) {
          // Silent — just log, no Telegram
          addLog(goal.id, floor.id, 'Steven', 'Heartbeat: ok');
        } else {
          addLog(goal.id, floor.id, 'Steven', `Issue: ${assessment.substring(0, 150)}`);
          const fixResult = await stevenFix(floor, goal, assessment);
          if (fixResult.fixed && fixResult.patches.length > 0) {
            // Only notify if patches were actually applied
            await notifyStevenAlert(floor.name, `${fixResult.patches.length} patch(es) applied`);
          }
        }
      } catch (floorErr) {
        console.error(`[Steven] Monitor error for ${floor.name}:`, floorErr.message);
      }
    }
  } catch (err) {
    console.error('[Steven] Monitor cycle failed:', err.message);
  }
}

module.exports = { stevenFix, stevenMonitor };
