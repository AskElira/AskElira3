#!/usr/bin/env node
/**
 * AskElira 3 — Monitor Report Generator
 * Reads data/monitor-results.json and produces a summary report.
 *
 * Usage: node test/integration/report.js
 */

const fs = require('fs');
const path = require('path');

const RESULTS_FILE = path.resolve(__dirname, '..', '..', 'data', 'monitor-results.json');

function generateReport() {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log('No monitor results found. Run the monitor first.');
    return;
  }

  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  if (results.length === 0) {
    console.log('No runs recorded yet.');
    return;
  }

  const first = results[0];
  const last = results[results.length - 1];
  const startTime = new Date(first.timestamp);
  const endTime = new Date(last.timestamp);
  const durationHrs = ((endTime - startTime) / 3600000).toFixed(1);

  const totalRuns = results.length;
  const cleanRuns = results.filter(r => r.failed === 0).length;
  const failedRuns = totalRuns - cleanRuns;
  const totalTests = results.reduce((sum, r) => sum + r.total, 0);
  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const passRate = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : '0';

  // Collect all unique failures
  const failureMap = {};
  for (const run of results) {
    for (const err of run.errors) {
      const key = err.name;
      if (!failureMap[key]) failureMap[key] = { count: 0, lastError: err.error, lastSeen: run.timestamp };
      failureMap[key].count++;
      failureMap[key].lastError = err.error;
      failureMap[key].lastSeen = run.timestamp;
    }
  }

  // Find longest streak of clean runs
  let maxStreak = 0, currentStreak = 0;
  for (const r of results) {
    if (r.failed === 0) { currentStreak++; maxStreak = Math.max(maxStreak, currentStreak); }
    else currentStreak = 0;
  }

  // Average test duration
  const avgDurations = {};
  for (const run of results) {
    for (const t of run.results) {
      if (!avgDurations[t.name]) avgDurations[t.name] = [];
      avgDurations[t.name].push(t.ms);
    }
  }
  const slowTests = Object.entries(avgDurations)
    .map(([name, times]) => ({ name, avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  // Print report
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       AskElira 3 — 12-Hour Monitoring Report            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Period:        ${startTime.toLocaleString()} → ${endTime.toLocaleString()} (${durationHrs}h)`);
  console.log(`  Total Runs:    ${totalRuns}`);
  console.log(`  Clean Runs:    ${cleanRuns}/${totalRuns} (${((cleanRuns/totalRuns)*100).toFixed(0)}%)`);
  console.log(`  Failed Runs:   ${failedRuns}`);
  console.log(`  Total Tests:   ${totalTests} (${totalPassed} pass, ${totalFailed} fail)`);
  console.log(`  Pass Rate:     ${passRate}%`);
  console.log(`  Best Streak:   ${maxStreak} consecutive clean runs`);
  console.log(`  Current:       ${currentStreak} consecutive clean`);
  console.log('');

  if (Object.keys(failureMap).length > 0) {
    console.log('  ── Failures Seen ──');
    for (const [name, info] of Object.entries(failureMap)) {
      console.log(`    ${name} (${info.count}x) — ${info.lastError}`);
    }
    console.log('');
  } else {
    console.log('  ── No Failures ── Perfect run.');
    console.log('');
  }

  console.log('  ── Slowest Tests (avg ms) ──');
  for (const t of slowTests) {
    const bar = '█'.repeat(Math.min(Math.round(t.avg / 20), 30));
    console.log(`    ${t.avg.toString().padStart(5)}ms ${bar} ${t.name}`);
  }
  console.log('');

  console.log('  ── Run-by-Run ──');
  for (const r of results) {
    const t = new Date(r.timestamp).toLocaleTimeString();
    const icon = r.failed === 0 ? '✅' : '❌';
    console.log(`    ${icon} ${t}  ${r.passed}/${r.total}${r.failed > 0 ? '  FAIL: ' + r.errors.map(e => e.name).join(', ') : ''}`);
  }
  console.log('');
  console.log('  Report generated: ' + new Date().toLocaleString());
  console.log('');
}

generateReport();
