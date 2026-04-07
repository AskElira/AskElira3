#!/usr/bin/env node
/**
 * AskElira3 Overnight Test — 12 hours of continuous testing.
 *
 * Phases:
 *   1. Health checks (every cycle)
 *   2. Simple builds (cycle 1-2)
 *   3. Complex builds (cycle 3-5)
 *   4. Chat & assistant tests (every other cycle)
 *   5. Agent coordination monitoring
 *   6. Bug detection + auto-fix attempts
 *   7. Morning report
 *
 * Writes report to: data/overnight-report.md
 * Writes log to:    data/overnight-test.log (stdout)
 */

const BASE = 'http://localhost:3000';
const REPORT_PATH = require('path').resolve(__dirname, '..', '..', 'data', 'overnight-report.md');
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes between cycles
const MAX_CYCLES = 48; // 48 x 15min = 12 hours
const BUILD_POLL_MS = 30_000;
const BUILD_TIMEOUT_MS = 60 * 60_000; // 60 min max per build (matches floor-runner hard ceiling)

const fs = require('fs');

// ── State ──
let cycle = 0;
const report = [];
const summary = { pass: 0, fail: 0, tests: [], builds: [], chats: [], bugs: [], fixes: [] };
const activeBuild = { goalId: null, name: null, startedAt: null };

// ── Logging ──
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  report.push(line);
}

function record(name, passed, detail = '') {
  summary.tests.push({ name, passed, detail, time: new Date().toISOString(), cycle });
  if (passed) summary.pass++; else summary.fail++;
  log(`  ${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

function recordBug(description, context) {
  summary.bugs.push({ description, context, time: new Date().toISOString(), cycle });
  log(`  BUG: ${description}`);
}

function recordFix(description) {
  summary.fixes.push({ description, time: new Date().toISOString(), cycle });
  log(`  FIX ATTEMPTED: ${description}`);
}

// ── API helpers ──
async function api(method, path, body = null, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, ok: false, json: null, text: err.message };
  }
}

async function chatMsg(content, goalId = null) {
  const body = { messages: [{ role: 'user', content }] };
  if (goalId) body.goalId = goalId;
  return api('POST', '/api/chat', body, 60000);
}

// ── Test Suites ──

async function healthChecks() {
  log('--- Health Checks ---');
  const [status, goals, stats, circuits, settings] = await Promise.all([
    api('GET', '/api/status'),
    api('GET', '/api/goals'),
    api('GET', '/api/stats/llm'),
    api('GET', '/api/stats/circuits'),
    api('GET', '/api/settings'),
  ]);

  record('status_up', status.ok, `uptime: ${status.json?.uptime || 0}s`);
  record('goals_list', goals.ok, `${goals.json?.length || 0} goals`);
  record('stats_llm', stats.ok, `${stats.json?.totals?.total_calls || 0} calls`);
  record('circuits_ok', circuits.ok);

  if (status.json) {
    log(`  Server: v${status.json.version}, model=${status.json.agentModel}, budget=${status.json.llmBudgetPct}%`);
    log(`  Goals: ${status.json.goalCount}, Floors: ${status.json.floorCount} (${status.json.floorsLive} live, ${status.json.floorsBlocked} blocked, ${status.json.floorsActive} active)`);
  }

  // Check circuit breaker health
  if (circuits.json) {
    for (const b of circuits.json) {
      if (b.state !== 'CLOSED') {
        recordBug(`Circuit "${b.name}" is ${b.state} (${b.failures}/${b.maxFailures} failures)`, 'circuit');
      }
    }
  }

  // Check for high blocked floor ratio
  if (status.json && status.json.floorCount > 0) {
    const blockedPct = (status.json.floorsBlocked / status.json.floorCount) * 100;
    if (blockedPct > 70) {
      recordBug(`${Math.round(blockedPct)}% of floors are blocked — possible systemic issue`, 'floors');
    }
  }

  return { status: status.json, goals: goals.json || [] };
}

// ── Build Tests ──

const SIMPLE_BUILDS = [
  'A Python script that converts CSV to JSON with error handling and a README',
  'A Node.js CLI tool that generates random passwords with customizable length and character sets',
  'A bash script that monitors disk usage and sends alerts when above 90%, with a config file',
];

const COMPLEX_BUILDS = [
  'A REST API in Node.js with Express: user registration, JWT auth, SQLite database, input validation, and rate limiting. Include tests.',
  'A real-time dashboard in HTML/CSS/JS that displays system metrics (CPU, memory, disk) with charts using Chart.js, auto-refreshing every 5 seconds, with dark mode toggle',
  'A Python web scraper framework: configurable targets via YAML, rate limiting, proxy rotation, result export to CSV/JSON, retry logic, and comprehensive error handling',
  'A markdown blog engine: Node.js server that reads .md files from a posts/ directory, renders them to HTML with syntax highlighting, has an index page with pagination, RSS feed, and search',
  'A task queue system in Python: producer/consumer pattern, SQLite backend for persistence, retry with exponential backoff, dead letter queue, CLI interface for managing jobs, and status dashboard',
];

async function startBuild(description) {
  log(`=== STARTING BUILD: "${description.substring(0, 60)}..." ===`);
  const r = await api('POST', '/api/goals', { text: description }, 60000);
  record('build_create', r.ok, `HTTP ${r.status}`);

  if (r.json?.id) {
    activeBuild.goalId = r.json.id;
    activeBuild.name = description.substring(0, 60);
    activeBuild.startedAt = Date.now();
    summary.builds.push({
      name: activeBuild.name,
      goalId: r.json.id,
      startedAt: new Date().toISOString(),
      status: 'started',
      floors: 0,
      floorsLive: 0,
      floorsBlocked: 0,
      durationMs: 0,
    });
    log(`  Goal created: ${r.json.id.substring(0, 8)}...`);
    return true;
  }
  log(`  BUILD FAILED TO CREATE: ${r.text?.substring(0, 200)}`);
  return false;
}

async function monitorBuild() {
  if (!activeBuild.goalId) return null;

  const r = await api('GET', `/api/goals/${activeBuild.goalId}`);
  if (!r.ok) {
    log(`  Build monitor error: HTTP ${r.status}`);
    return 'error';
  }

  const g = r.json;
  const elapsed = Math.round((Date.now() - activeBuild.startedAt) / 1000);
  log(`  Build "${activeBuild.name}" [${elapsed}s]: status=${g.status}`);

  if (g.floors) {
    for (const f of g.floors) {
      const step = f.current_step ? ` step=${f.current_step}` : '';
      const scores = `vex1=${f.vex1_score ?? '-'} vex2=${f.vex2_score ?? '-'}`;
      log(`    F${f.floor_number} "${f.name}": ${f.status}${step} ${scores}`);
    }
  }

  // Update build record
  const buildRec = summary.builds[summary.builds.length - 1];
  if (buildRec && buildRec.goalId === activeBuild.goalId) {
    buildRec.status = g.status;
    buildRec.floors = g.floors?.length || 0;
    buildRec.floorsLive = g.floors?.filter(f => f.status === 'live').length || 0;
    buildRec.floorsBlocked = g.floors?.filter(f => f.status === 'blocked').length || 0;
    buildRec.durationMs = Date.now() - activeBuild.startedAt;
  }

  // Check for timeout
  if (Date.now() - activeBuild.startedAt > BUILD_TIMEOUT_MS) {
    log(`  BUILD TIMEOUT after ${BUILD_TIMEOUT_MS / 60000}min`);
    recordBug(`Build "${activeBuild.name}" timed out after ${BUILD_TIMEOUT_MS / 60000}min (status: ${g.status})`, 'timeout');
    return 'timeout';
  }

  // Terminal states
  const terminal = ['goal_met', 'completed', 'partial', 'blocked'];
  if (terminal.includes(g.status)) return g.status;

  // Check for all floors blocked (stuck build)
  if (g.floors && g.floors.length > 0) {
    const allBlocked = g.floors.every(f => f.status === 'blocked' || f.status === 'live');
    const anyLive = g.floors.some(f => f.status === 'live');
    const anyBlocked = g.floors.some(f => f.status === 'blocked');
    if (allBlocked && anyBlocked && !g.floors.some(f => ['researching','building','auditing','reviewing','pending'].includes(f.status))) {
      return anyLive ? 'partial' : 'blocked';
    }
  }

  return 'in_progress';
}

async function finishBuild(finalStatus) {
  if (!activeBuild.goalId) return;

  const elapsed = Math.round((Date.now() - activeBuild.startedAt) / 1000);
  const success = finalStatus === 'goal_met' || finalStatus === 'completed';
  record('build_completed', success, `status=${finalStatus}, ${elapsed}s`);

  // Inspect final state
  const detail = await api('GET', `/api/goals/${activeBuild.goalId}`);
  if (detail.json?.floors) {
    const live = detail.json.floors.filter(f => f.status === 'live').length;
    const blocked = detail.json.floors.filter(f => f.status === 'blocked').length;
    const total = detail.json.floors.length;
    log(`  Final: ${live}/${total} live, ${blocked} blocked`);

    // Check for low vex scores
    for (const f of detail.json.floors) {
      if (f.vex1_score !== null && f.vex1_score < 50) {
        recordBug(`Floor "${f.name}" has low Vex1 score: ${f.vex1_score}`, 'quality');
      }
      if (f.vex2_score !== null && f.vex2_score < 50) {
        recordBug(`Floor "${f.name}" has low Vex2 score: ${f.vex2_score}`, 'quality');
      }
    }

    // Check workspace files
    const files = await api('GET', `/api/goals/${activeBuild.goalId}/files`);
    if (files.json) {
      log(`  Workspace: ${files.json.length} files — ${files.json.join(', ')}`);
      if (files.json.length === 0 && live > 0) {
        recordBug(`Build has ${live} live floors but 0 workspace files`, 'integrity');
      }
    }
  }

  log(`=== BUILD FINISHED: ${finalStatus} (${elapsed}s) ===`);

  // Don't delete — keep for inspection. Just clear active state.
  activeBuild.goalId = null;
  activeBuild.name = null;
  activeBuild.startedAt = null;
}

// ── Chat & Assistant Tests ──

const CHAT_TESTS = [
  // Status/info questions
  { q: 'What goals are currently active?', expect: 'mentions goals or status', tag: 'status' },
  { q: 'How many floors are blocked right now?', expect: 'mentions number or blocked', tag: 'status' },
  { q: 'What model are you using?', expect: 'mentions MiniMax or model name', tag: 'info' },

  // General assistant questions
  { q: 'What is the difference between REST and GraphQL?', expect: 'explains both', tag: 'knowledge' },
  { q: 'How do I set up a Python virtual environment?', expect: 'mentions venv or virtualenv', tag: 'howto' },
  { q: 'Explain JWT authentication in simple terms', expect: 'mentions token or authentication', tag: 'knowledge' },
  { q: 'What are the best practices for error handling in Node.js?', expect: 'mentions try/catch or error', tag: 'knowledge' },

  // Creative/assistant tasks
  { q: 'Write me a haiku about coding', expect: 'short poem', tag: 'creative' },
  { q: 'Summarize what AskElira does in one paragraph', expect: 'mentions building or agents', tag: 'self' },
  { q: 'If I wanted to build a trading bot, what would the architecture look like?', expect: 'mentions components or strategy', tag: 'advice' },

  // Context-aware
  { q: 'What was the last thing you built?', expect: 'references a goal or build', tag: 'context' },
  { q: 'Are there any problems I should know about?', expect: 'mentions blocked or issues or healthy', tag: 'diagnostic' },
  { q: 'What improvements would you suggest for the current builds?', expect: 'suggests something', tag: 'advice' },
];

async function runChatTests(count = 3) {
  log('--- Chat & Assistant Tests ---');
  // Pick random tests
  const shuffled = [...CHAT_TESTS].sort(() => Math.random() - 0.5);
  const tests = shuffled.slice(0, count);

  for (const t of tests) {
    const r = await chatMsg(t.q);
    const reply = r.json?.reply || '';
    const hasContent = reply.length > 20;
    const notFallback = !reply.includes('No response generated');
    const passed = hasContent && notFallback;

    record(`chat_${t.tag}`, passed, `${reply.length} chars`);
    summary.chats.push({ question: t.q, tag: t.tag, replyLen: reply.length, passed, cycle });

    if (passed) {
      log(`    Q: "${t.q.substring(0, 50)}..."`);
      log(`    A: "${reply.substring(0, 120)}..."`);
    } else {
      log(`    Q: "${t.q}"`);
      log(`    A: "${reply.substring(0, 200)}" (EXPECTED: ${t.expect})`);
      if (!hasContent) {
        recordBug(`Empty/short chat reply for "${t.q.substring(0, 40)}" (${reply.length} chars)`, 'chat');
      }
    }
  }
}

// ── Agent Coordination Monitoring ──

async function monitorAgents() {
  log('--- Agent Coordination ---');
  const metrics = await api('GET', '/api/stats/metrics');
  if (!metrics.ok || !metrics.json) {
    record('agent_metrics', false, 'endpoint failed');
    return;
  }

  const { byAgent, floorStats, recentFailures } = metrics.json;

  if (byAgent && byAgent.length > 0) {
    log('  Agent performance:');
    for (const a of byAgent) {
      const rate = a.total > 0 ? Math.round((a.successes / a.total) * 100) : 0;
      log(`    ${a.agent}/${a.event}: ${rate}% success (${a.successes}/${a.total}), avg ${a.avg_duration_ms}ms`);

      // Flag low success rates
      if (a.total >= 3 && rate < 50) {
        recordBug(`Agent ${a.agent}/${a.event} has ${rate}% success rate (${a.successes}/${a.total})`, 'agent');
      }
    }
  }

  if (floorStats) {
    log(`  Floor stats: ${floorStats.total_floors} completed, ${floorStats.live_floors} live, avg ${floorStats.avg_floor_ms}ms`);
  }

  if (recentFailures && recentFailures.length > 0) {
    log(`  Recent failures (${recentFailures.length}):`);
    const uniqueFailures = new Map();
    for (const f of recentFailures.slice(0, 10)) {
      const key = `${f.agent}/${f.event}`;
      if (!uniqueFailures.has(key)) uniqueFailures.set(key, []);
      uniqueFailures.get(key).push(f.metadata || 'no detail');
    }
    for (const [key, reasons] of uniqueFailures) {
      log(`    ${key}: ${reasons[0]} (x${reasons.length})`);
    }
  }

  record('agent_metrics', true);
}

// ── Blocked Floor Auto-Fix ──

async function attemptFixes() {
  log('--- Auto-Fix Check ---');
  const goals = await api('GET', '/api/goals');
  if (!goals.ok || !goals.json) return;

  // Find goals with blocked floors from recent builds (not old ones)
  const recentGoals = goals.json.filter(g => {
    const created = g.created_at * 1000 || Date.parse(g.created_at);
    return Date.now() - created < 24 * 60 * 60 * 1000; // last 24h
  });

  for (const g of recentGoals) {
    if (g.floorsBlocked > 0 && g.status !== 'goal_met') {
      log(`  Goal "${g.text.substring(0, 40)}" has ${g.floorsBlocked} blocked floors — triggering fix`);
      const fixResult = await api('POST', `/api/goals/${g.id}/fix`, {}, 120000);
      if (fixResult.ok) {
        recordFix(`Triggered Steven fix for "${g.text.substring(0, 40)}" — floor: ${fixResult.json?.floorName || 'unknown'}`);
      } else {
        log(`  Fix trigger failed: ${fixResult.text?.substring(0, 100)}`);
      }
      break; // One fix per cycle to avoid overload
    }
  }
}

// ── Build Scheduler ──

const buildQueue = [];
let buildIndex = 0;

function initBuildQueue() {
  // Interleave simple and complex builds across the 12 hours
  // Cycle 1: simple, Cycle 3: simple, Cycle 5: complex, Cycle 8: complex,
  // Cycle 11: simple, Cycle 15: complex, Cycle 20: complex, Cycle 25: complex
  const schedule = [
    { cycle: 1,  desc: SIMPLE_BUILDS[0] },
    { cycle: 4,  desc: SIMPLE_BUILDS[1] },
    { cycle: 8,  desc: COMPLEX_BUILDS[0] },
    { cycle: 12, desc: SIMPLE_BUILDS[2] },
    { cycle: 16, desc: COMPLEX_BUILDS[1] },
    { cycle: 22, desc: COMPLEX_BUILDS[2] },
    { cycle: 28, desc: COMPLEX_BUILDS[3] },
    { cycle: 35, desc: COMPLEX_BUILDS[4] },
  ];
  buildQueue.push(...schedule);
}

// ── Main Cycle ──

async function runCycle() {
  cycle++;
  log(`\n${'='.repeat(60)}`);
  log(`CYCLE ${cycle}/${MAX_CYCLES} — ${new Date().toLocaleString()}`);
  log('='.repeat(60));

  try {
    // 1. Health checks every cycle
    const { status, goals } = await healthChecks();

    // 2. Check if we should start a build
    const scheduledBuild = buildQueue.find(b => b.cycle === cycle);
    if (scheduledBuild && !activeBuild.goalId) {
      await startBuild(scheduledBuild.desc);
    }

    // 3. Monitor active build
    if (activeBuild.goalId) {
      const buildStatus = await monitorBuild();
      if (buildStatus && buildStatus !== 'in_progress') {
        await finishBuild(buildStatus);
      }
    }

    // 4. Chat tests (every other cycle, and not during the first few seconds of a build)
    if (cycle % 2 === 0 || cycle <= 2) {
      await runChatTests(cycle % 4 === 0 ? 4 : 2);
    }

    // 5. Agent monitoring (every 4 cycles)
    if (cycle % 4 === 0) {
      await monitorAgents();
    }

    // 6. Auto-fix attempts (every 6 cycles)
    if (cycle % 6 === 0) {
      await attemptFixes();
    }

  } catch (err) {
    log(`CYCLE ERROR: ${err.message}`);
    record('cycle_error', false, err.message);
  }

  // Write report after each cycle
  writeReport();
}

// ── Report ──

function writeReport() {
  const now = new Date().toISOString();
  const elapsed = cycle * INTERVAL_MS;
  const hours = (elapsed / 3600000).toFixed(1);

  let md = `# AskElira3 Overnight Test Report\n\n`;
  md += `**Generated**: ${now}\n`;
  md += `**Duration**: ${hours}h (${cycle}/${MAX_CYCLES} cycles)\n`;
  md += `**Tests**: ${summary.pass} passed, ${summary.fail} failed (${summary.pass + summary.fail} total)\n`;
  md += `**Builds**: ${summary.builds.length} attempted\n`;
  md += `**Bugs found**: ${summary.bugs.length}\n`;
  md += `**Fix attempts**: ${summary.fixes.length}\n\n`;

  // Build Results
  if (summary.builds.length > 0) {
    md += `## Builds\n\n`;
    md += `| # | Name | Status | Floors | Live | Blocked | Duration |\n`;
    md += `|---|------|--------|--------|------|---------|----------|\n`;
    for (let i = 0; i < summary.builds.length; i++) {
      const b = summary.builds[i];
      const dur = b.durationMs ? `${Math.round(b.durationMs / 1000)}s` : 'ongoing';
      const icon = b.status === 'goal_met' ? 'OK' : b.status === 'started' ? '...' : 'X';
      md += `| ${i + 1} | ${b.name} | ${icon} ${b.status} | ${b.floors} | ${b.floorsLive} | ${b.floorsBlocked} | ${dur} |\n`;
    }
    md += `\n`;
  }

  // Chat Results
  if (summary.chats.length > 0) {
    const chatPass = summary.chats.filter(c => c.passed).length;
    const chatTotal = summary.chats.length;
    const byTag = {};
    for (const c of summary.chats) {
      if (!byTag[c.tag]) byTag[c.tag] = { pass: 0, total: 0 };
      byTag[c.tag].total++;
      if (c.passed) byTag[c.tag].pass++;
    }
    md += `## Chat Tests (${chatPass}/${chatTotal} passed)\n\n`;
    md += `| Category | Pass Rate |\n|----------|----------|\n`;
    for (const [tag, data] of Object.entries(byTag)) {
      md += `| ${tag} | ${data.pass}/${data.total} (${Math.round(data.pass/data.total*100)}%) |\n`;
    }
    md += `\n`;
  }

  // Bugs
  if (summary.bugs.length > 0) {
    md += `## Bugs Detected\n\n`;
    for (const b of summary.bugs) {
      md += `- **[Cycle ${b.cycle}]** ${b.description} _(${b.context})_\n`;
    }
    md += `\n`;
  }

  // Fixes
  if (summary.fixes.length > 0) {
    md += `## Fix Attempts\n\n`;
    for (const f of summary.fixes) {
      md += `- **[Cycle ${f.cycle}]** ${f.description}\n`;
    }
    md += `\n`;
  }

  // Failures
  const failures = summary.tests.filter(t => !t.passed);
  if (failures.length > 0) {
    md += `## Test Failures\n\n`;
    for (const f of failures) {
      md += `- **[Cycle ${f.cycle}]** ${f.name}: ${f.detail || 'no detail'}\n`;
    }
    md += `\n`;
  }

  md += `## Full Log\n\n<details><summary>Click to expand (${report.length} lines)</summary>\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n\n</details>\n`;

  fs.writeFileSync(REPORT_PATH, md);
}

// ── Entry ──

async function main() {
  log('AskElira3 Overnight Test — Starting');
  log(`Plan: ${MAX_CYCLES} cycles, ${INTERVAL_MS / 60000}min intervals, ~${Math.round(MAX_CYCLES * INTERVAL_MS / 3600000)}h`);
  log(`Builds scheduled: ${SIMPLE_BUILDS.length} simple + ${COMPLEX_BUILDS.length} complex`);
  log(`Report: ${REPORT_PATH}`);

  initBuildQueue();

  // Run first cycle immediately
  await runCycle();

  // Schedule remaining
  let remaining = MAX_CYCLES - 1;
  const timer = setInterval(async () => {
    if (remaining <= 0) {
      clearInterval(timer);
      log(`\n${'='.repeat(60)}`);
      log('OVERNIGHT TEST COMPLETE');
      log('='.repeat(60));
      writeReport();
      process.exit(0);
    }
    remaining--;
    await runCycle();
  }, INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('\nSIGTERM received — writing final report');
    writeReport();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    log('\nSIGINT received — writing final report');
    writeReport();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Overnight test fatal:', err);
  process.exit(1);
});
