#!/usr/bin/env node

const path = require('path');
const readline = require('readline');

// Load env from project root
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { config, validate } = require('../src/config');
const { listGoals, listFloors, getLogs } = require('../src/db');
const { hermesChat, hermesRoute } = require('../src/hermes/index');
const { runPlanner } = require('../src/pipeline/planner');
const { runPipeline } = require('../src/pipeline/floor-runner');
const { fixFloor } = require('../src/agents/steven');
const workspace = require('../src/pipeline/workspace');

const args = process.argv.slice(2);

async function main() {
  if (args.includes('--status')) {
    showStatus();
    return;
  }

  if (args.includes('--logs')) {
    const goalId = args[args.indexOf('--logs') + 1];
    showLogs(goalId);
    return;
  }

  if (args.includes('--fix')) {
    const floorId = args[args.indexOf('--fix') + 1];
    if (!floorId) {
      console.error('Usage: askelira3 --fix <floor-id>');
      process.exit(1);
    }
    await runFix(floorId);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }

  if (!validate()) {
    process.exit(1);
  }

  // If goal text provided as args, run it
  const goalText = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (goalText) {
    await runGoal(goalText);
    return;
  }

  // Interactive mode
  await interactive();
}

function showHelp() {
  console.log(`
AskElira 3 CLI — Hermes-powered building automation

Usage:
  askelira3 "build me a blog API"    Run a goal
  askelira3 --status                 Show all goals
  askelira3 --logs [goalId]          Show recent logs
  askelira3 --fix <floorId>          Trigger Steven to fix a floor
  askelira3                          Interactive chat with Hermes
  askelira3 --help                   Show this help

Agents: Alba (research) -> Vex (validate) -> David (build) -> Elira (approve) -> Steven (fix)
`);
}

function showStatus() {
  const goals = listGoals();
  if (!goals.length) {
    console.log('No goals yet.');
    return;
  }
  console.log(`\n  Goals (${goals.length})\n`);
  for (const g of goals) {
    const floors = listFloors(g.id);
    const live = floors.filter(f => f.status === 'live').length;
    const blocked = floors.filter(f => f.status === 'blocked').length;
    const total = floors.length;
    const bar = total > 0 ? `[${live}/${total} live${blocked ? ', ' + blocked + ' blocked' : ''}]` : '';
    const files = workspace.listFiles(g.id);
    const filesInfo = files.length > 0 ? ` (${files.length} files)` : '';
    console.log(`  ${statusIcon(g.status)} ${g.text.substring(0, 55).padEnd(55)} ${g.status.padEnd(12)} ${bar}${filesInfo}`);
  }
  console.log('');
}

function statusIcon(status) {
  const icons = {
    planning: '.',
    building: '>',
    goal_met: '+',
    blocked: 'X',
    partial: '~',
  };
  return icons[status] || '?';
}

function showLogs(goalId) {
  const logs = getLogs({ goalId, limit: 50 });
  if (!logs.length) {
    console.log('No logs found.');
    return;
  }
  for (const l of logs.reverse()) {
    const time = new Date(l.created_at * 1000).toLocaleTimeString();
    const agent = l.agent.padEnd(8);
    console.log(`  ${time}  [${agent}]  ${l.message}`);
  }
}

async function runFix(floorId) {
  console.log(`\n[Steven] Triggering fix for floor: ${floorId}\n`);
  try {
    const result = await fixFloor(floorId);
    console.log(`[Steven] Fix ${result.fixed ? 'SUCCEEDED' : 'INCOMPLETE'}`);
    console.log(`[Steven] ${result.summary}`);
  } catch (err) {
    console.error(`[Steven] Fix failed: ${err.message}`);
  }
}

async function runGoal(text) {
  console.log(`\n[Hermes] Creating goal: ${text}\n`);
  const goal = await hermesRoute(text);
  console.log(`[Hermes] Goal ID: ${goal.id}`);

  console.log('[Hermes/Elira] Designing building plan...');
  const floors = await runPlanner(goal);
  console.log(`[Hermes/Elira] ${floors.length} floors planned\n`);

  for (const f of floors) {
    console.log(`  F${f.floor_number}: ${f.name}`);
    if (f.deliverable) console.log(`      Deliverable: ${f.deliverable}`);
  }
  console.log('');

  console.log('[Pipeline] Starting execution (Alba -> Vex1 -> David -> Vex2 -> Elira)...\n');
  await runPipeline(goal, floors);

  console.log('\n[Hermes] Pipeline complete.');
  showStatus();

  // Show workspace files
  const files = workspace.listFiles(goal.id);
  if (files.length > 0) {
    console.log(`  Workspace files (${files.length}):`);
    for (const f of files) {
      console.log(`    ${f}`);
    }
    console.log(`  Path: ${workspace.getWorkspacePath(goal.id)}`);
  }
}

async function interactive() {
  console.log('\nAskElira 3 -- Chat with Hermes (Elira + Steven)');
  console.log('Type /build <goal> to start a build, /status to see goals, /fix <floorId>, /quit to exit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You> ',
  });

  const history = [];
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text === '/quit' || text === '/exit') {
      console.log('Goodbye.');
      process.exit(0);
    }

    if (text === '/status') {
      showStatus();
      rl.prompt();
      return;
    }

    if (text.startsWith('/build ')) {
      const goalText = text.substring(7).trim();
      if (goalText) {
        await runGoal(goalText);
      } else {
        console.log('Usage: /build <goal description>');
      }
      rl.prompt();
      return;
    }

    if (text.startsWith('/fix ')) {
      const floorId = text.substring(5).trim();
      if (floorId) {
        await runFix(floorId);
      } else {
        console.log('Usage: /fix <floor-id>');
      }
      rl.prompt();
      return;
    }

    // Chat with Hermes
    history.push({ role: 'user', content: text });
    try {
      const reply = await hermesChat(history);
      history.push({ role: 'assistant', content: reply });
      console.log(`\nHermes> ${reply}\n`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
    rl.prompt();
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
