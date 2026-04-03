#!/usr/bin/env node
/**
 * AskElira 3 — Continuous Integration Monitor
 *
 * Tests every user-facing feature every 30 minutes for 12 hours.
 * If something breaks, logs detailed diagnostics.
 *
 * Usage:
 *   node test/integration/monitor.js              # Single run
 *   node test/integration/monitor.js --loop       # Loop every 30min for 12h
 *   node test/integration/monitor.js --loop --interval=10  # Custom interval (minutes)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_FILE = path.join(ROOT, 'data', 'monitor.log');
const RESULTS_FILE = path.join(ROOT, 'data', 'monitor-results.json');

// Ensure data dir exists
const dataDir = path.join(ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Logging ──
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logSection(title) {
  log('');
  log(`════ ${title} ════`);
}

// ── Test runner ──
class TestSuite {
  constructor() {
    this.results = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  async run(name, fn) {
    const start = Date.now();
    try {
      await fn();
      const ms = Date.now() - start;
      this.results.push({ name, pass: true, ms });
      this.passed++;
      log(`  ✅ ${name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - start;
      this.results.push({ name, pass: false, ms, error: err.message });
      this.failed++;
      this.errors.push({ name, error: err.message, stack: err.stack });
      log(`  ❌ ${name}: ${err.message}`);
    }
  }

  summary() {
    return {
      timestamp: new Date().toISOString(),
      total: this.passed + this.failed,
      passed: this.passed,
      failed: this.failed,
      errors: this.errors,
      results: this.results,
    };
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ══════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════

async function testModuleLoading(suite) {
  logSection('Module Loading');

  const modules = [
    ['db', './src/db'],
    ['config', './src/config'],
    ['llm', './src/llm'],
    ['hermes/index', './src/hermes/index'],
    ['hermes/agi', './src/hermes/agi'],
    ['agents/alba', './src/agents/alba'],
    ['agents/david', './src/agents/david'],
    ['agents/vex', './src/agents/vex'],
    ['agents/steven', './src/agents/steven'],
    ['pipeline/floor-runner', './src/pipeline/floor-runner'],
    ['pipeline/workspace', './src/pipeline/workspace'],
    ['pipeline/planner', './src/pipeline/planner'],
    ['web/routes', './src/web/routes'],
    ['notify', './src/notify'],
    ['executor', './src/executor'],
    ['scheduler', './src/scheduler'],
    ['user-model', './src/user-model'],
    ['settings', './src/settings'],
    ['circuit-breaker', './src/circuit-breaker'],
    ['schema-validator', './src/schema-validator'],
    ['steven-heartbeat', './src/steven-heartbeat'],
  ];

  for (const [name, modPath] of modules) {
    await suite.run(`Load ${name}`, () => {
      const fullPath = path.resolve(ROOT, modPath);
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      assert(mod !== undefined, `${name} returned undefined`);
    });
  }
}

async function testDatabase(suite) {
  logSection('Database Operations');
  const db = require(path.resolve(ROOT, 'src/db'));

  await suite.run('createGoal + getGoal', () => {
    const goal = db.createGoal('__monitor_test_goal__');
    assert(goal && goal.id, 'Goal not created');
    const fetched = db.getGoal(goal.id);
    assert(fetched && fetched.text === '__monitor_test_goal__', 'Goal fetch mismatch');
    db.deleteGoal(goal.id); // cleanup
  });

  await suite.run('createFloor + listFloors', () => {
    const goal = db.createGoal('__monitor_floor_test__');
    const floor = db.createFloor(goal.id, 1, 'Test Floor', 'desc', 'pass', 'file.js');
    assert(floor && floor.id, 'Floor not created');
    const floors = db.listFloors(goal.id);
    assert(floors.length === 1, `Expected 1 floor, got ${floors.length}`);
    db.deleteGoal(goal.id);
  });

  await suite.run('addLog + getLogs', () => {
    db.addLog('__test__', null, 'Monitor', 'test log entry');
    const logs = db.getLogs({ goalId: '__test__', limit: 1 });
    assert(logs.length >= 1, 'Log not stored');
    db.db.prepare("DELETE FROM logs WHERE goal_id = '__test__'").run();
  });

  await suite.run('recordMetric + getMetricsSummary', () => {
    db.recordMetric({ goalId: '__test__', floorId: null, agent: 'Monitor', event: 'monitor_test', durationMs: 1, success: true });
    const summary = db.getMetricsSummary();
    assert(summary && Array.isArray(summary.byAgent), 'Metrics summary invalid');
    db.db.prepare("DELETE FROM metrics WHERE agent = 'Monitor'").run();
  });

  await suite.run('addWebChatMessage + getWebChatMessages', () => {
    const id = db.addWebChatMessage('user', '__monitor_chat_test__');
    assert(id, 'Web chat message not stored');
    const msgs = db.getWebChatMessages(5);
    assert(msgs.some(m => m.content === '__monitor_chat_test__'), 'Web chat message not found');
    db.db.prepare("DELETE FROM telegram_messages WHERE content = '__monitor_chat_test__'").run();
  });

  await suite.run('getRecentTelegramMessages', () => {
    const msgs = db.getRecentTelegramMessages(5);
    assert(Array.isArray(msgs), 'Expected array');
  });

  await suite.run('deleteGoal cascade', () => {
    const goal = db.createGoal('__monitor_delete_test__');
    db.createFloor(goal.id, 1, 'F1', 'desc');
    db.addLog(goal.id, null, 'Monitor', 'test');
    const deleted = db.deleteGoal(goal.id);
    assert(deleted, 'Delete returned null');
    assert(!db.getGoal(goal.id), 'Goal still exists after delete');
    assert(db.listFloors(goal.id).length === 0, 'Floors still exist after delete');
  });
}

async function testSchemaValidation(suite) {
  logSection('Schema Validation');
  const { validateSchema, SchemaValidationError, VEX_RESEARCH_SCHEMA, VEX_BUILD_SCHEMA, DAVID_BUILD_SCHEMA, APPROVE_SCHEMA, FIX_SCHEMA } = require(path.resolve(ROOT, 'src/schema-validator'));

  await suite.run('Rejects null input', () => {
    try { validateSchema(null, VEX_BUILD_SCHEMA); assert(false); }
    catch (e) { assert(e instanceof SchemaValidationError, 'Wrong error type'); }
  });

  await suite.run('Rejects missing required fields', () => {
    try { validateSchema({}, DAVID_BUILD_SCHEMA); assert(false); }
    catch (e) { assert(e.violations.length > 0); }
  });

  await suite.run('Rejects wrong types', () => {
    try { validateSchema({ valid: 'yes', score: 'high' }, VEX_RESEARCH_SCHEMA); assert(false); }
    catch (e) { assert(e.violations.length >= 2); }
  });

  await suite.run('Accepts valid Vex research', () => {
    validateSchema({ valid: true, issues: [], score: 85 }, VEX_RESEARCH_SCHEMA);
  });

  await suite.run('Accepts valid David build', () => {
    validateSchema({ summary: 'ok', files: { 'a.js': 'code' } }, DAVID_BUILD_SCHEMA);
  });

  await suite.run('Accepts valid approval', () => {
    validateSchema({ approved: true, feedback: 'ok', fixes: [] }, APPROVE_SCHEMA);
  });

  await suite.run('Accepts valid fix', () => {
    validateSchema({ diagnosis: 'bug', patches: [{ file: 'a.js', content: 'fix' }] }, FIX_SCHEMA);
  });
}

async function testCircuitBreaker(suite) {
  logSection('Circuit Breaker');
  const { CircuitBreaker, CircuitOpenError, STATES } = require(path.resolve(ROOT, 'src/circuit-breaker'));

  await suite.run('Starts CLOSED', () => {
    const b = new CircuitBreaker('monitor-test', { maxFailures: 2, cooldownMs: 500 });
    assert(b.getState() === STATES.CLOSED);
  });

  await suite.run('Trips to OPEN after maxFailures', async () => {
    const b = new CircuitBreaker('monitor-trip', { maxFailures: 2, cooldownMs: 60000 });
    try { await b.call(async () => { throw new Error('f1'); }); } catch (_) {}
    try { await b.call(async () => { throw new Error('f2'); }); } catch (_) {}
    assert(b.getState() === STATES.OPEN, `Expected OPEN, got ${b.getState()}`);
  });

  await suite.run('Rejects when OPEN', async () => {
    const b = new CircuitBreaker('monitor-reject', { maxFailures: 1, cooldownMs: 60000 });
    try { await b.call(async () => { throw new Error('fail'); }); } catch (_) {}
    try { await b.call(async () => 'should not run'); assert(false); }
    catch (e) { assert(e instanceof CircuitOpenError, 'Wrong error type'); }
  });

  await suite.run('Resets on success', async () => {
    const b = new CircuitBreaker('monitor-reset', { maxFailures: 3 });
    try { await b.call(async () => { throw new Error('fail'); }); } catch (_) {}
    await b.call(async () => 'ok');
    assert(b.failures === 0, `Failures not reset: ${b.failures}`);
  });
}

async function testWorkspace(suite) {
  logSection('Workspace Operations');
  const ws = require(path.resolve(ROOT, 'src/pipeline/workspace'));
  const testId = '__monitor_ws_' + Date.now();

  await suite.run('Write + read file', () => {
    return ws.writeFile(testId, 'hello.txt', 'world').then(() => {
      const content = ws.readFile(testId, 'hello.txt');
      assert(content === 'world', `Content mismatch: ${content}`);
    });
  });

  await suite.run('List files', () => {
    const files = ws.listFiles(testId);
    assert(files.includes('hello.txt'), 'File not listed');
  });

  await suite.run('Concurrent writes serialize', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      ws.writeFile(testId, `concurrent_${i}.txt`, `data_${i}`)
    );
    await Promise.all(writes);
    const files = ws.listFiles(testId);
    assert(files.length >= 6, `Expected 6+ files, got ${files.length}`);
  });

  await suite.run('Path traversal blocked', () => {
    try { ws.readFile(testId, '../../.env'); assert(false, 'Should have thrown'); }
    catch (e) { assert(e.message.includes('traversal'), `Wrong error: ${e.message}`); }
  });

  await suite.run('Delete workspace', () => {
    const deleted = ws.deleteWorkspace(testId);
    assert(deleted, 'Delete returned false');
    assert(ws.listFiles(testId).length === 0, 'Files remain after delete');
  });
}

async function testTimeouts(suite) {
  logSection('Timeout Protection');
  const frSource = fs.readFileSync(path.resolve(ROOT, 'src/pipeline/floor-runner.js'), 'utf8');
  const llmSource = fs.readFileSync(path.resolve(ROOT, 'src/llm.js'), 'utf8');

  await suite.run('LLM fetchWithTimeout exists', () => {
    assert(llmSource.includes('function fetchWithTimeout'), 'Missing fetchWithTimeout');
    assert(llmSource.includes('AbortController'), 'Missing AbortController');
  });

  await suite.run('All 3 LLM fetch paths use timeout', () => {
    const count = (llmSource.match(/fetchWithTimeout/g) || []).length;
    assert(count >= 3, `Only ${count} fetchWithTimeout calls, expected 3+`);
  });

  await suite.run('Pipeline withTimeout wraps all agents', () => {
    const agents = ['alba.research', 'davidBuild', 'vex.vexValidateResearch', 'vex.vexValidateBuild', 'hermes.hermesApprove', 'hermes.hermesFix', 'runFloor'];
    for (const agent of agents) {
      assert(frSource.includes('withTimeout(' + agent), `Missing withTimeout for ${agent}`);
    }
  });

  await suite.run('Vex2 bypass removed (enforcing)', () => {
    assert(!frSource.includes('vex2Passed = true; // Let Elira decide'), 'Old bypass still present');
    assert(frSource.includes('BLOCKED on final iteration'), 'New blocking behavior missing');
  });
}

async function testHeartbeat(suite) {
  logSection('Heartbeat / Steven');
  const hbSource = fs.readFileSync(path.resolve(ROOT, 'src/steven-heartbeat.js'), 'utf8');

  await suite.run('MAX_FIX_ATTEMPTS defined', () => {
    assert(hbSource.includes('MAX_FIX_ATTEMPTS'), 'Missing constant');
  });

  await suite.run('Fix attempts tracked and capped', () => {
    assert(hbSource.includes('fixAttempts'), 'Missing tracking');
    assert(hbSource.includes('attempts >= MAX_FIX_ATTEMPTS'), 'Missing cap check');
  });

  await suite.run('Gives up with alert', () => {
    assert(hbSource.includes('gaveUp'), 'Missing gaveUp flag');
    assert(hbSource.includes('gave up on'), 'Missing give-up message');
  });

  await suite.run('Resets on success', () => {
    assert(hbSource.includes('fixAttempts = 0'), 'Missing reset');
  });
}

async function testFrontend(suite) {
  logSection('Frontend Files');

  await suite.run('index.html exists and valid', () => {
    const html = fs.readFileSync(path.resolve(ROOT, 'src/web/public/index.html'), 'utf8');
    assert(html.includes('AskElira'), 'Missing AskElira title');
    assert(html.includes('style.css'), 'Missing CSS link');
    assert(html.includes('app.js'), 'Missing JS link');
  });

  await suite.run('style.css uses Ember/Warm Gold theme', () => {
    const css = fs.readFileSync(path.resolve(ROOT, 'src/web/public/style.css'), 'utf8');
    assert(css.includes('#ffc53d'), 'Missing amber accent');
    assert(css.includes('#111110'), 'Missing warm black bg');
    assert(css.includes('--accent-text: #16120c'), 'Missing dark text on amber');
  });

  await suite.run('app.js has delete, chat persistence, web history', () => {
    const js = fs.readFileSync(path.resolve(ROOT, 'src/web/public/app.js'), 'utf8');
    assert(js.includes('performDelete'), 'Missing delete function');
    assert(js.includes('loadWebChatHistory'), 'Missing chat persistence');
    assert(js.includes('/api/chat-messages'), 'Missing chat messages endpoint');
  });

  await suite.run('No personal identifiers in frontend', () => {
    const html = fs.readFileSync(path.resolve(ROOT, 'src/web/public/theme-preview.html'), 'utf8');
    assert(!html.includes('OpenClawd'), 'Personal identifier found');
  });
}

async function testAPIEndpoints(suite) {
  logSection('API Route Definitions');
  const routes = fs.readFileSync(path.resolve(ROOT, 'src/web/routes.js'), 'utf8');

  const endpoints = [
    ["GET /api/goals", "get('/api/goals'"],
    ["POST /api/goals", "post('/api/goals'"],
    ["DELETE /api/goals/:id", "delete('/api/goals/:id'"],
    ["GET /api/goals/:id", "get('/api/goals/:id'"],
    ["GET /api/goals/:id/files", "/api/goals/:id/files"],
    ["POST /api/chat", "post('/api/chat'"],
    ["GET /api/chat-messages", "/api/chat-messages"],
    ["GET /api/status", "/api/status"],
    ["GET /api/stats/metrics", "/api/stats/metrics"],
    ["GET /api/stats/circuits", "/api/stats/circuits"],
    ["GET /api/telegram-messages", "/api/telegram-messages"],
    ["POST /api/floors/:id/fix", "/api/floors/:id/fix"],
    ["GET /api/user-model", "/api/user-model"],
    ["GET /api/settings", "/api/settings"],
  ];

  for (const [name, pattern] of endpoints) {
    await suite.run(`Route: ${name}`, () => {
      assert(routes.includes(pattern), `Route not found: ${pattern}`);
    });
  }
}

async function testIntentClassifier(suite) {
  logSection('Intent Classifier');
  const server = fs.readFileSync(path.resolve(ROOT, 'src/web/server.js'), 'utf8');

  await suite.run('classifyIntent function exists', () => {
    assert(server.includes('async function classifyIntent'), 'Missing classifier');
  });

  await suite.run('Uses agentModel (cheap model)', () => {
    assert(server.includes('config.agentModel') && server.includes('classifyIntent'), 'Not using agentModel');
  });

  await suite.run('Confirmation states checked before classifier', () => {
    // Confirmations are in STEP 1, classifier is in STEP 3
    const step1Idx = server.indexOf('STEP 1: Check pending confirmation');
    const step3Idx = server.indexOf('STEP 3: LLM intent classifier');
    assert(step1Idx > 0 && step3Idx > 0 && step1Idx < step3Idx, 'Confirmations must run before classifier');
  });

  await suite.run('Fast-path for simple commands', () => {
    assert(server.includes('/^(status|goals'), 'Missing status fast-path');
    assert(server.includes('/^fix$/i'), 'Missing fix fast-path');
  });

  await suite.run('Disambiguation at low confidence', () => {
    assert(server.includes('ambiguous') && server.includes('confidence'), 'Missing disambiguation');
  });

  await suite.run('Recent conversation injected into context', () => {
    assert(server.includes('recentMessages') && server.includes('getRecentTelegramMessages'), 'Missing conversation memory');
    assert(server.includes('## Recent Conversation'), 'Missing in system context');
  });
}

async function testSuggestionValidation(suite) {
  logSection('AGI Suggestion Validation');
  const agi = fs.readFileSync(path.resolve(ROOT, 'src/hermes/agi.js'), 'utf8');

  await suite.run('isValidSuggestion function exists', () => {
    assert(agi.includes('function isValidSuggestion'), 'Missing validation');
  });

  await suite.run('Rejects short suggestions', () => {
    assert(agi.includes('s.length < 15'), 'Missing length check');
  });

  await suite.run('Rejects pronoun-only suggestions', () => {
    assert(agi.includes('build it') || agi.includes('do it'), 'Missing pronoun rejection');
  });

  await suite.run('Used before addSuggestion', () => {
    assert(agi.includes('isValidSuggestion(suggestion)'), 'Not called before storing');
  });
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

async function runAllTests() {
  log('╔══════════════════════════════════════════════╗');
  log('║  AskElira 3 — Integration Monitor            ║');
  log('╚══════════════════════════════════════════════╝');

  const suite = new TestSuite();

  await testModuleLoading(suite);
  await testDatabase(suite);
  await testSchemaValidation(suite);
  await testCircuitBreaker(suite);
  await testWorkspace(suite);
  await testTimeouts(suite);
  await testHeartbeat(suite);
  await testFrontend(suite);
  await testAPIEndpoints(suite);
  await testIntentClassifier(suite);
  await testSuggestionValidation(suite);

  const summary = suite.summary();

  log('');
  log('══════════════════════════════════════════════');
  log(`  RESULT: ${summary.passed}/${summary.total} PASS | ${summary.failed} FAIL`);
  log('══════════════════════════════════════════════');

  if (summary.errors.length > 0) {
    log('');
    log('FAILURES:');
    for (const err of summary.errors) {
      log(`  - ${err.name}: ${err.error}`);
    }
  }

  // Save results
  const history = [];
  try { history.push(...JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))); } catch (_) {}
  history.push(summary);
  // Keep last 100 runs
  if (history.length > 100) history.splice(0, history.length - 100);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(history, null, 2));

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const isLoop = args.includes('--loop');
  const intervalMatch = args.find(a => a.startsWith('--interval='));
  const intervalMin = intervalMatch ? parseInt(intervalMatch.split('=')[1]) : 30;
  const maxHours = 12;
  const maxRuns = Math.floor((maxHours * 60) / intervalMin);

  if (!isLoop) {
    const summary = await runAllTests();
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // Loop mode
  log(`Starting monitor loop: every ${intervalMin}min for ${maxHours}h (max ${maxRuns} runs)`);
  let runCount = 0;
  let consecutiveClean = 0;

  while (runCount < maxRuns) {
    runCount++;
    log(`\n\n${'='.repeat(60)}`);
    log(`  RUN ${runCount}/${maxRuns} — ${new Date().toLocaleString()}`);
    log(`${'='.repeat(60)}`);

    const summary = await runAllTests();

    if (summary.failed === 0) {
      consecutiveClean++;
      log(`\n  All clear (${consecutiveClean} consecutive clean runs)`);
    } else {
      consecutiveClean = 0;
      log(`\n  ⚠️ ${summary.failed} failures detected — logged to ${LOG_FILE}`);
    }

    if (runCount < maxRuns) {
      log(`  Next run in ${intervalMin} minutes...`);
      await new Promise(r => setTimeout(r, intervalMin * 60 * 1000));
    }
  }

  log(`\nMonitor complete: ${runCount} runs finished.`);
}

main().catch(err => {
  console.error('Monitor crashed:', err);
  process.exit(1);
});
