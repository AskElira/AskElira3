#!/usr/bin/env node
/**
 * AskElira3 Soak Test — runs every 10 minutes for ~3 hours.
 * Tests: status, chat, build lifecycle, floor monitoring, stats, settings.
 * Writes report to data/soak-report.md
 */

const BASE = 'http://localhost:3000';
const REPORT_PATH = require('path').resolve(__dirname, '..', '..', 'data', 'soak-report.md');
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RUNS = 18; // 18 x 10min = 3 hours
const BUILD_POLL_MS = 30_000; // check build every 30s
const BUILD_TIMEOUT_MS = 15 * 60_000; // 15min max per build

const fs = require('fs');
let report = [];
let runCount = 0;
let buildGoalId = null;
let buildStarted = false;
let testSummary = { pass: 0, fail: 0, tests: [] };

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  report.push(line);
}

function record(name, passed, detail = '') {
  testSummary.tests.push({ name, passed, detail, time: new Date().toISOString() });
  if (passed) testSummary.pass++;
  else testSummary.fail++;
  log(`  ${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text };
}

// ── Test suites ──

async function testStatus() {
  log('--- Testing /api/status ---');
  const r = await api('GET', '/api/status');
  record('status_endpoint', r.ok, `HTTP ${r.status}`);
  if (r.json) {
    record('status_has_llm', r.json.llm === true);
    record('status_has_telegram', r.json.telegram === true);
    record('status_version', r.json.version === '3.0.0', r.json.version);
    record('status_uptime', r.json.uptime > 0, `${r.json.uptime}s`);
    log(`  Goals: ${r.json.goalCount}, Floors: ${r.json.floorCount} (${r.json.floorsLive} live, ${r.json.floorsBlocked} blocked, ${r.json.floorsActive} active)`);
    log(`  LLM budget: ${r.json.llmBudgetPct}%, Model: ${r.json.agentModel}`);
  }
}

async function testChat() {
  log('--- Testing /api/chat ---');
  const messages = [{ role: 'user', content: 'What goals are currently active? Give a brief summary.' }];
  const r = await api('POST', '/api/chat', { messages });
  record('chat_endpoint', r.ok, `HTTP ${r.status}`);
  if (r.json) {
    record('chat_has_reply', typeof r.json.reply === 'string' && r.json.reply.length > 10, `${r.json.reply?.length || 0} chars`);
    log(`  Reply preview: "${(r.json.reply || '').substring(0, 120)}..."`);
  }
}

async function testGoalsList() {
  log('--- Testing /api/goals ---');
  const r = await api('GET', '/api/goals');
  record('goals_list', r.ok && Array.isArray(r.json), `${r.json?.length || 0} goals`);
  if (r.json && r.json.length > 0) {
    const g = r.json[0];
    log(`  Most recent: "${g.text?.substring(0, 60)}" [${g.status}] — ${g.floorCount} floors (${g.floorsLive} live, ${g.floorsBlocked} blocked)`);
  }
  return r.json || [];
}

async function testGoalDetail(goalId) {
  log(`--- Testing /api/goals/${goalId.substring(0, 8)}... ---`);
  const r = await api('GET', `/api/goals/${goalId}`);
  record('goal_detail', r.ok, `status: ${r.json?.status}`);
  if (r.json?.floors) {
    for (const f of r.json.floors) {
      log(`  Floor ${f.floor_number}: "${f.name}" [${f.status}] step=${f.current_step || 'none'} vex1=${f.vex1_score ?? '-'} vex2=${f.vex2_score ?? '-'}`);
    }
    log(`  Workspace files: ${r.json.workspaceFiles?.length || 0}`);
  }
  return r.json;
}

async function testStats() {
  log('--- Testing stats endpoints ---');
  const [llm, metrics, circuits] = await Promise.all([
    api('GET', '/api/stats/llm'),
    api('GET', '/api/stats/metrics'),
    api('GET', '/api/stats/circuits'),
  ]);
  record('stats_llm', llm.ok, `${llm.json?.totals?.total_calls || 0} calls, ${llm.json?.totals?.total_tokens || 0} tokens`);
  record('stats_metrics', metrics.ok);
  record('stats_circuits', circuits.ok);
  if (circuits.json) {
    for (const b of circuits.json) {
      log(`  Circuit "${b.name}": ${b.state} (failures: ${b.failures}/${b.maxFailures})`);
    }
  }
  if (metrics.json?.floorStats) {
    const fs = metrics.json.floorStats;
    log(`  Floor stats: ${fs.total_floors} total, ${fs.live_floors} live, avg ${fs.avg_floor_ms}ms`);
  }
  if (metrics.json?.recentFailures?.length > 0) {
    log(`  Recent failures: ${metrics.json.recentFailures.length}`);
    for (const f of metrics.json.recentFailures.slice(0, 3)) {
      log(`    - ${f.agent}/${f.event}: ${f.metadata || 'no detail'}`);
    }
  }
}

async function testSettings() {
  log('--- Testing /api/settings ---');
  const r = await api('GET', '/api/settings');
  record('settings_endpoint', r.ok);
  if (r.json?.notifications) {
    const n = r.json.notifications;
    log(`  Notifications: floorLive=${n.floorLive}, floorBlocked=${n.floorBlocked}, buildComplete=${n.buildComplete}, stevenAlerts=${n.stevenAlerts}`);
  }
}

async function testLogs() {
  log('--- Testing /api/logs ---');
  const r = await api('GET', '/api/logs?limit=10');
  record('logs_endpoint', r.ok && Array.isArray(r.json), `${r.json?.length || 0} entries`);
  if (r.json?.length > 0) {
    const recent = r.json[0];
    log(`  Latest: [${recent.agent}] ${recent.message?.substring(0, 80)}`);
  }
}

async function testTelegramMessages() {
  log('--- Testing /api/telegram-messages ---');
  const r = await api('GET', '/api/telegram-messages?limit=5');
  record('telegram_messages', r.ok && Array.isArray(r.json), `${r.json?.length || 0} messages`);
}

// ── Build lifecycle test ──

async function startBuild() {
  log('=== STARTING BUILD TEST ===');
  const buildText = 'Test soak: a simple Python hello world script with unit tests';
  const r = await api('POST', '/api/goals', { text: buildText });
  record('build_create', r.ok, `HTTP ${r.status}`);
  if (r.json?.id) {
    buildGoalId = r.json.id;
    buildStarted = true;
    log(`  Goal created: ${buildGoalId.substring(0, 8)}... — "${buildText}"`);
  } else {
    log(`  Build creation failed: ${r.text?.substring(0, 200)}`);
  }
}

async function monitorBuild() {
  if (!buildGoalId) return;
  const r = await api('GET', `/api/goals/${buildGoalId}`);
  if (!r.ok) {
    log(`  Build monitor: HTTP ${r.status}`);
    return r.json?.status || 'unknown';
  }
  const g = r.json;
  log(`  Build "${g.text?.substring(0, 40)}": status=${g.status}`);
  if (g.floors) {
    for (const f of g.floors) {
      const step = f.current_step ? ` step=${f.current_step}` : '';
      log(`    F${f.floor_number} "${f.name}": ${f.status}${step}`);
    }
  }
  return g.status;
}

async function cleanupBuild() {
  if (!buildGoalId) return;
  log('--- Cleaning up test build ---');
  const r = await api('DELETE', `/api/goals/${buildGoalId}`);
  record('build_cleanup', r.ok, `deleted: ${r.json?.deleted}`);
  buildGoalId = null;
  buildStarted = false;
}

// ── Main loop ──

async function runTestCycle() {
  runCount++;
  log(`\n========== SOAK TEST RUN #${runCount}/${MAX_RUNS} ==========`);

  try {
    // Always run health checks
    await testStatus();
    await testGoalsList().then(async goals => {
      if (goals.length > 0) await testGoalDetail(goals[0].id);
    });
    await testStats();
    await testSettings();
    await testLogs();
    await testTelegramMessages();

    // Chat test every other run
    if (runCount % 2 === 1) {
      await testChat();
    }

    // Start a build on run 2, monitor until done, then clean up
    if (runCount === 2 && !buildStarted) {
      await startBuild();
    }

    // Monitor active build
    if (buildGoalId) {
      const status = await monitorBuild();
      const terminal = ['goal_met', 'completed', 'partial', 'blocked'];
      if (terminal.includes(status)) {
        record('build_completed', status === 'goal_met' || status === 'completed', `final status: ${status}`);
        log(`=== BUILD FINISHED: ${status} ===`);
        // Inspect the final state
        await testGoalDetail(buildGoalId);
        await cleanupBuild();
      }
    }
  } catch (err) {
    log(`ERROR in test cycle: ${err.message}`);
    record('cycle_error', false, err.message);
  }

  // Write report after each cycle
  writeReport();
}

function writeReport() {
  const now = new Date().toISOString();
  let md = `# AskElira3 Soak Test Report\n\n`;
  md += `**Generated**: ${now}\n`;
  md += `**Runs completed**: ${runCount}/${MAX_RUNS}\n`;
  md += `**Tests passed**: ${testSummary.pass}/${testSummary.pass + testSummary.fail}\n`;
  md += `**Tests failed**: ${testSummary.fail}\n\n`;

  if (testSummary.fail > 0) {
    md += `## Failures\n\n`;
    for (const t of testSummary.tests.filter(t => !t.passed)) {
      md += `- **${t.name}**: ${t.detail || 'no detail'} (${t.time})\n`;
    }
    md += `\n`;
  }

  md += `## Full Log\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`;

  fs.writeFileSync(REPORT_PATH, md);
}

// ── Entry point ──

async function main() {
  log('AskElira3 Soak Test starting');
  log(`Plan: ${MAX_RUNS} runs, ${INTERVAL_MS / 60000}min intervals, ~${Math.round(MAX_RUNS * INTERVAL_MS / 3600000)}h total`);
  log(`Report: ${REPORT_PATH}`);

  // Run first cycle immediately
  await runTestCycle();

  // Schedule remaining cycles
  let remaining = MAX_RUNS - 1;
  const timer = setInterval(async () => {
    if (remaining <= 0) {
      clearInterval(timer);
      log('\n========== SOAK TEST COMPLETE ==========');
      writeReport();
      process.exit(0);
    }
    remaining--;
    await runTestCycle();
  }, INTERVAL_MS);
}

main().catch(err => {
  console.error('Soak test fatal:', err);
  process.exit(1);
});
