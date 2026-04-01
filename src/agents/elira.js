/**
 * Elira agent — now a thin wrapper around Hermes (Elira mode).
 * Kept for backward compatibility with planner.js and CLI.
 */
const { hermesPlan, hermesApprove } = require('../hermes/index');
const { addLog } = require('../db');

/**
 * Elira plans the building — decomposes a goal into floors.
 * Delegates to hermesPlan.
 */
async function plan(goalText, goalId) {
  addLog(goalId, null, 'Elira', 'Designing building plan...');
  const floors = await hermesPlan(goalText);
  addLog(goalId, null, 'Elira', `Building plan: ${floors.length} floors designed`);
  return floors;
}

/**
 * Elira approves or rejects David's output.
 * Delegates to hermesApprove.
 */
async function approve(floor, davidOutput, goalId) {
  addLog(goalId, floor.id, 'Elira', `Reviewing David's output for: ${floor.name}`);
  const result = await hermesApprove(floor, davidOutput);
  const status = result.approved ? 'APPROVED' : 'REJECTED';
  addLog(goalId, floor.id, 'Elira', `${status}: ${result.feedback}`);
  return result;
}

module.exports = { plan, approve };
