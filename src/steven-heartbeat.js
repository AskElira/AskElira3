/**
 * Steven Heartbeat — autonomous monitor loop.
 *
 * Runs every 5 minutes (configurable via HEARTBEAT_INTERVAL_MS env).
 * - Queries DB for all goals with status 'building' or 'blocked'
 * - For each blocked floor: calls fixFloor() from steven.js (max 1 fix attempt per floor per cycle)
 * - For each building floor stalled >30 min: logs a warning
 * - Tracks lastChecked per floor in data/heartbeat-state.json
 * - Every 6 hours: sends a Steven fix summary to Telegram (no per-fix alerts)
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
const SUMMARY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_FIX_ATTEMPTS = parseInt(process.env.MAX_FIX_ATTEMPTS || '5', 10);

const STATE_FILE = path.resolve(__dirname, '..', 'data', 'heartbeat-state.json');

let heartbeatTimer = null;
let summaryTimer = null;

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

// ── 6-hour Steven fix summary ───────────────────────────────────────────────

async function sendStevenSummary() {
  const state = loadState();
  const now = Date.now();
  const sixHoursAgo = now - SUMMARY_INTERVAL_MS;

  const fixes = Object.entries(state).filter(([key, val]) => {
    return val.lastFixAttempt && val.lastFixAttempt > sixHoursAgo;
  });

  if (fixes.length === 0) return;

  const lines = fixes.map(([floorId, val]) => {
    const icon = val.lastFixResult === 'fixed' ? '✅' : val.lastFixResult === 'failed' ? '⚠️' : '❌';
    const ago = Math.round((now - val.lastFixAttempt) / 60000);
    return `${icon} ${val.floorName || floorId.substring(0, 8)} — ${val.lastFixResult} (${ago}m ago)`;
  });

  const summary = `*Steven Summary (6h)*\n\n${lines.join('\n')}`;
  await sendTelegram(summary);
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

        // Update lastChecked
        if (!state[stateKey]) state[stateKey] = {};
        state[stateKey].lastChecked = now;
        state[stateKey].floorName = floor.name;

        // ── Blocked floors: auto-fix (with attempt cap) ──
        if (floor.status === 'blocked' && !fixedThisCycle.has(floor.id)) {
          const attempts = state[stateKey].fixAttempts || 0;

          if (attempts >= MAX_FIX_ATTEMPTS) {
            // Already gave up — don't retry
            if (!state[stateKey].gaveUp) {
              state[stateKey].gaveUp = true;
              console.warn(`[Heartbeat] Giving up on "${floor.name}" after ${MAX_FIX_ATTEMPTS} failed fix attempts`);
              addLog(goal.id, floor.id, 'Steven', `Heartbeat: giving up after ${MAX_FIX_ATTEMPTS} failed fix attempts`);
              sendTelegram(`⛔ Steven gave up on "${floor.name}" after ${MAX_FIX_ATTEMPTS} failed attempts. Manual intervention needed.`).catch(() => {});
            }
          } else {
            fixedThisCycle.add(floor.id);

            console.log(`[Heartbeat] Auto-fixing blocked floor: ${floor.name} (attempt ${attempts + 1}/${MAX_FIX_ATTEMPTS})`);
            addLog(goal.id, floor.id, 'Steven', `Heartbeat: auto-fix attempt ${attempts + 1}/${MAX_FIX_ATTEMPTS}`);

            try {
              const result = await fixFloor(floor.id, `Heartbeat: floor "${floor.name}" is blocked. Status: ${floor.status}`);
              state[stateKey].lastFixAttempt = now;

              if (result.fixed) {
                state[stateKey].lastFixResult = 'fixed';
                state[stateKey].fixAttempts = 0; // reset on success
                state[stateKey].gaveUp = false;
                console.log(`[Heartbeat] Fixed: ${floor.name}`);
                addLog(goal.id, floor.id, 'Steven', `Heartbeat: auto-fix succeeded`);
              } else {
                state[stateKey].lastFixResult = 'failed';
                state[stateKey].fixAttempts = attempts + 1;
                console.log(`[Heartbeat] Fix failed: ${floor.name} (${attempts + 1}/${MAX_FIX_ATTEMPTS})`);
                addLog(goal.id, floor.id, 'Steven', `Heartbeat: auto-fix failed — ${result.summary || 'no details'}`);
              }
            } catch (err) {
              console.error(`[Heartbeat] Fix error for ${floor.name}:`, err.message);
              addLog(goal.id, floor.id, 'Steven', `Heartbeat: fix error — ${err.message}`);
              state[stateKey].lastFixAttempt = now;
              state[stateKey].lastFixResult = 'error';
              // Don't count transient upstream errors against the attempt budget
              const isTransient = /429|500|502|503|504|529|overloaded|rate.?limit|timeout|ECONNRESET|ETIMEDOUT/i.test(err.message);
              if (!isTransient) {
                state[stateKey].fixAttempts = attempts + 1;
              } else {
                console.log(`[Heartbeat] Transient error — not counting against attempt budget`);
              }
            }
          }
        }

        // ── Building floors: stall detection ──
        if (floor.status === 'building') {
          const floorCreatedAt = (floor.created_at || 0) * 1000;
          const reference = lastChecked || floorCreatedAt;
          const elapsed = now - reference;

          if (elapsed > STALL_THRESHOLD_MS) {
            const stallMinutes = Math.round(elapsed / 60000);
            const msg = `Floor "${floor.name}" has not progressed in ${stallMinutes} minutes`;
            console.warn(`[Heartbeat] STALL: ${msg}`);
            addLog(goal.id, floor.id, 'Steven', `Heartbeat stall warning: ${msg}`);

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
  console.log(`[Heartbeat] Steven monitor started (interval: ${INTERVAL_MS / 1000}s, summary: every ${SUMMARY_INTERVAL_MS / 3600000}h)`);
  heartbeatTimer = setInterval(heartbeatCycle, INTERVAL_MS);
  summaryTimer = setInterval(sendStevenSummary, SUMMARY_INTERVAL_MS);
  // Run first check after a short delay to let the server finish booting
  setTimeout(heartbeatCycle, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  console.log('[Heartbeat] Steven monitor stopped');
}

module.exports = { startHeartbeat, stopHeartbeat };
