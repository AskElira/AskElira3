/**
 * Steven Heartbeat — autonomous monitor loop.
 *
 * Runs every 5 minutes (configurable via HEARTBEAT_INTERVAL_MS env).
 * - Queries DB for all goals with status 'building' or 'blocked'
 * - For each blocked floor: calls fixFloor() from steven.js (max 1 fix attempt per floor per cycle)
 * - For each building floor stalled >30 min: logs a warning + Telegram alert
 * - Tracks lastChecked per floor in data/heartbeat-state.json
 * - Sends Telegram on auto-fix
 *
 * Exports: startHeartbeat(), stopHeartbeat()
 */

const fs = require('fs');
const path = require('path');
const { listGoals, listFloors, getGoal, addLog } = require('./db');
const { fixFloor } = require('./agents/steven');
const { sendTelegram } = require('./notify');
const { config } = require('./config');

const INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || String(5 * 60 * 1000), 10);
const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

const STATE_FILE = path.resolve(__dirname, '..', 'data', 'heartbeat-state.json');

let heartbeatTimer = null;

// ── State persistence ───────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[Heartbeat] Failed to save state:', err.message);
  }
}

// ── Core cycle ──────────────────────────────────────────────────────────────

async function heartbeatCycle() {
  try {
    const goals = listGoals();
    const activeGoals = goals.filter(g => g.status === 'building' || g.status === 'blocked');

    if (activeGoals.length === 0) return;

    const state = loadState();
    const now = Date.now();
    const fixedThisCycle = new Set(); // max 1 fix attempt per floor per cycle

    for (const goal of activeGoals) {
      const floors = listFloors(goal.id);

      for (const floor of floors) {
        const stateKey = floor.id;
        const lastChecked = state[stateKey]?.lastChecked || 0;
        const lastFixAttempt = state[stateKey]?.lastFixAttempt || 0;

        // Update lastChecked
        if (!state[stateKey]) state[stateKey] = {};
        state[stateKey].lastChecked = now;
        state[stateKey].floorName = floor.name;

        // ── Blocked floors: auto-fix ──
        if (floor.status === 'blocked' && !fixedThisCycle.has(floor.id)) {
          fixedThisCycle.add(floor.id);

          console.log(`[Heartbeat] Auto-fixing blocked floor: ${floor.name}`);
          addLog(goal.id, floor.id, 'Steven', 'Heartbeat: auto-fix triggered for blocked floor');

          try {
            const result = await fixFloor(floor.id, `Heartbeat: floor "${floor.name}" is blocked. Status: ${floor.status}`);
            state[stateKey].lastFixAttempt = now;
            state[stateKey].lastFixResult = result.fixed ? 'fixed' : 'failed';

            if (result.fixed) {
              console.log(`[Heartbeat] Fixed: ${floor.name}`);
              addLog(goal.id, floor.id, 'Steven', `Heartbeat: auto-fix succeeded`);
              if (config.hasTelegram) {
                await sendTelegram(`\u{1F493} Steven fixed ${floor.name} automatically`);
              }
            } else {
              console.log(`[Heartbeat] Fix failed: ${floor.name}`);
              addLog(goal.id, floor.id, 'Steven', `Heartbeat: auto-fix failed — ${result.summary || 'no details'}`);
            }
          } catch (err) {
            console.error(`[Heartbeat] Fix error for ${floor.name}:`, err.message);
            addLog(goal.id, floor.id, 'Steven', `Heartbeat: fix error — ${err.message}`);
            state[stateKey].lastFixAttempt = now;
            state[stateKey].lastFixResult = 'error';
          }
        }

        // ── Building floors: stall detection ──
        if (floor.status === 'building') {
          const floorCreatedAt = (floor.created_at || 0) * 1000;
          // Use last state check or floor creation time as reference
          const reference = lastChecked || floorCreatedAt;
          const elapsed = now - reference;

          if (elapsed > STALL_THRESHOLD_MS) {
            const stallMinutes = Math.round(elapsed / 60000);
            const msg = `Floor "${floor.name}" has not progressed in ${stallMinutes} minutes`;
            console.warn(`[Heartbeat] STALL: ${msg}`);
            addLog(goal.id, floor.id, 'Steven', `Heartbeat stall warning: ${msg}`);

            if (config.hasTelegram) {
              await sendTelegram(`\u26A0\uFE0F *Stall Warning*\n${msg}\nGoal: ${goal.text.substring(0, 60)}`);
            }

            state[stateKey].lastStallWarning = now;
          }
        }
      }
    }

    saveState(state);
  } catch (err) {
    console.error('[Heartbeat] Cycle error:', err.message);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function startHeartbeat() {
  if (heartbeatTimer) {
    console.log('[Heartbeat] Already running');
    return;
  }
  console.log(`[Heartbeat] Steven monitor started (interval: ${INTERVAL_MS / 1000}s)`);
  heartbeatTimer = setInterval(heartbeatCycle, INTERVAL_MS);
  // Run first check after a short delay to let the server finish booting
  setTimeout(heartbeatCycle, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('[Heartbeat] Steven monitor stopped');
  }
}

module.exports = { startHeartbeat, stopHeartbeat };
