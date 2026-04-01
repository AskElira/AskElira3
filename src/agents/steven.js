const { stevenFix, stevenMonitor } = require('../pipeline/fixer');
const { getFloor, getGoal, addLog } = require('../db');

let heartbeatInterval = null;

/**
 * Start Steven's heartbeat monitor.
 * Checks live floors every 10 minutes for health issues.
 * @param {number} intervalMs - default 10 minutes
 */
function startHeartbeat(intervalMs = 10 * 60 * 1000) {
  if (heartbeatInterval) {
    console.log('[Steven] Heartbeat already running');
    return;
  }
  console.log(`[Steven] Heartbeat started (interval: ${intervalMs / 1000}s)`);
  heartbeatInterval = setInterval(stevenMonitor, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[Steven] Heartbeat stopped');
  }
}

/**
 * Manually trigger Steven to fix a specific floor.
 * @param {string} floorId
 * @param {string} [errorReport] - optional error description
 * @returns {Promise<{fixed: boolean, patches: Array, summary: string}>}
 */
async function fixFloor(floorId, errorReport) {
  const floor = getFloor(floorId);
  if (!floor) throw new Error(`Floor ${floorId} not found`);

  const goal = getGoal(floor.goal_id);
  if (!goal) throw new Error(`Goal ${floor.goal_id} not found`);

  const error = errorReport || `Floor "${floor.name}" is blocked or broken. Status: ${floor.status}`;
  addLog(goal.id, floor.id, 'Steven', `Manual fix triggered: ${error.substring(0, 100)}`);

  return stevenFix(floor, goal, error);
}

/**
 * Run a single heartbeat check (for manual/API triggers).
 */
async function runHeartbeatOnce() {
  return stevenMonitor();
}

module.exports = { startHeartbeat, stopHeartbeat, fixFloor, runHeartbeatOnce };
