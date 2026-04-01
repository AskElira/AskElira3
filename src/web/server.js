const express = require('express');
const path = require('path');
const { config, validate } = require('../config');
const routes = require('./routes');
const { startHeartbeat } = require('../steven-heartbeat');
const { startScheduler } = require('../scheduler');
const { startSelfImproveLoop } = require('../self-improve');
const { migrate: migrateMemory } = require('../memory');

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use(routes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
function start() {
  if (!validate()) {
    console.error('[Server] Configuration invalid. Check your .env file.');
    process.exit(1);
  }

  // Run memory migration before anything else
  migrateMemory();

  app.listen(config.port, () => {
    console.log(`[Server] AskElira 3 running at http://localhost:${config.port}`);
    console.log(`[Server] Hermes: unified intelligence (Elira + Steven modes)`);
    console.log(`[Server] LLM: ${config.isAnthropic ? 'Anthropic' : 'OpenAI-compatible'} (${config.eliraModel})`);
    console.log(`[Server] Telegram: ${config.hasTelegram ? 'enabled' : 'disabled'}`);
    console.log(`[Server] Web search: ${config.hasTavily ? 'Tavily' : config.hasBrave ? 'Brave' : 'disabled'}`);
    console.log(`[Server] AgentMail: ${config.hasAgentmail ? `enabled -> ${config.digestEmail} @ 8am` : 'disabled'}`);
    console.log(`[Server] Workspaces: ${path.join(process.cwd(), 'workspaces')}`);
  });

  // Start Steven's heartbeat (new autonomous monitor)
  startHeartbeat();

  // Start daily digest scheduler (timezone-aware)
  startScheduler();

  // Start self-improvement pattern analysis loop (every 6h)
  startSelfImproveLoop();

  // Start Telegram bot polling
  if (config.hasTelegram) {
    startTelegramPolling();
  }

  // AGI proactive loop — every 4 hours, Hermes thinks about the user
  if (config.hasTelegram) {
    setInterval(async () => {
      try {
        const agi = require('../hermes/agi');
        const { sendTelegram } = require('../notify');
        const msg = await agi.proactiveThink();
        if (msg) await sendTelegram(`*Hermes*\n\n${msg}`);
      } catch (_) {}
    }, 4 * 60 * 60 * 1000);
  }

  function gracefulShutdown(signal) {
    console.log(`[Server] ${signal} received — shutting down`);
    const { stopHeartbeat } = require('../steven-heartbeat');
    const { stopSelfImproveLoop } = require('../self-improve');
    stopHeartbeat();
    stopSelfImproveLoop();
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err.message, err.stack);
    // Do NOT exit — launchd manages restarts
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason);
  });
}

// ── Telegram Bot ──
let telegramOffset = 0;

function buildSystemContext(model) {
  const { listGoals, listFloors } = require('../db');
  const workspace = require('../pipeline/workspace');
  const goals = listGoals();

  // Load user model if not passed
  if (!model) {
    try { model = require('../user-model').get(); } catch (_) { model = null; }
  }

  const goalSummaries = goals.slice(0, 5).map(g => {
    const floors = listFloors(g.id);
    const live = floors.filter(f => f.status === 'live').length;
    const files = workspace.listFiles(g.id);
    return `- "${g.text.substring(0, 60)}" [${g.status}] — ${live}/${floors.length} floors live, ${files.length} files`;
  }).join('\n') || 'No goals yet.';

  const userSection = model ? `\n## What I Know About You
Name: ${model.name || 'unknown'}
Interests: ${model.interests.join(', ') || 'learning...'}
Tech stack: ${model.techStack.join(', ') || 'learning...'}
Goals: ${model.goals.join(', ') || 'learning...'}
Patterns: ${model.workflowPatterns.join(', ') || 'learning...'}
Queued suggestions: ${model.suggestedNext.slice(0, 3).join(' | ') || 'none'}` : '';

  return `## You Are Hermes — AskElira 3
You are the AI running inside AskElira 3, installed locally on the user's machine.
You are responding via Telegram. You ARE the bot. Do not suggest setting up a bot — you are it.

## What You Can Do
- Start a new build: user says "build X" → you confirm and it starts
- Check status: show all goals and floors
- Send the daily digest now: trigger it immediately
- Answer questions about any workspace file or build
- Fix broken floors

## Commands You Understand (natural language, no slash required)
- "build [goal]" or "create [goal]" → starts a new pipeline
- "status" or "what's running" → lists all goals
- "digest" or "send digest" → triggers the daily email now
- "files" or "show workspace" → lists workspace files for latest goal
- "fix" → triggers Steven on the most blocked floor
- Anything else → answer from context

## Current System State
LLM: ${config.eliraModel} | AgentMail: ${config.hasAgentmail ? `→ ${config.digestEmail}` : 'off'} | Web search: ${config.hasTavily ? 'Tavily' : config.hasBrave ? 'Brave' : 'off'}

## Goals (${goals.length} total)
${goalSummaries}
${userSection}

## Rules
- Never ask if the user has a Telegram token — you are the bot
- Never ask for SMTP — AgentMail handles email
- If the user wants to build something, DO IT — call the pipeline, then confirm
- Be concise in Telegram replies (under 300 chars when possible, use line breaks)
- When confirming a build started, say what floors you planned`;
}

async function handleTelegramMessage(userText) {
  const { hermesChat, hermesPlan } = require('../hermes/index');
  const { sendTelegram } = require('../notify');
  const { listGoals, listFloors, createGoal, addLog } = require('../db');
  const { runPlanner } = require('../pipeline/planner');
  const { runPipeline } = require('../pipeline/floor-runner');
  const { triggerNow } = require('../scheduler');
  const workspace = require('../pipeline/workspace');

  // AGI: learn from this message + update last seen
  const agi = require('../hermes/agi');
  const userModelMod = require('../user-model');
  userModelMod.touch();
  agi.learnFromMessage(userText).catch(() => {});

  const lower = userText.toLowerCase().trim();

  // ── Command: build it (builds last AGI suggestion) ──
  if (/^build it\.?$/i.test(lower)) {
    const userModelMod2 = require('../user-model');
    const model2 = userModelMod2.get();
    const suggestion = model2.suggestedNext?.[0];
    if (suggestion) {
      userModelMod2.clearSuggestion(suggestion);
      // Re-route as a build command
      return handleTelegramMessage(`build ${suggestion}`);
    }
    return sendTelegram('No suggestion queued. Tell me what to build.');
  }

  // ── Command: status ──
  if (/^(status|goals|what.s running|show goals)/i.test(lower)) {
    const goals = listGoals();
    if (!goals.length) return sendTelegram('No goals yet. Send me something to build!');
    const lines = goals.slice(0, 5).map(g => {
      const floors = listFloors(g.id);
      const live = floors.filter(f => f.status === 'live').length;
      const blocked = floors.filter(f => f.status === 'blocked').length;
      const icon = g.status === 'goal_met' ? '✅' : g.status === 'blocked' ? '🔴' : g.status === 'building' ? '🔨' : '⏳';
      return `${icon} ${g.text.substring(0, 45)}\n   ${live}/${floors.length} live${blocked ? `, ${blocked} blocked` : ''}`;
    });
    return sendTelegram(`*Goals*\n\n${lines.join('\n\n')}`);
  }

  // ── Command: digest ──
  if (/^(digest|send digest|send email|news)/i.test(lower)) {
    await sendTelegram('Sending digest now...');
    triggerNow().catch(e => sendTelegram(`Digest error: ${e.message}`));
    return;
  }

  // ── Command: files / workspace ──
  if (/^(files|workspace|show files|ls)/i.test(lower)) {
    const goals = listGoals();
    if (!goals.length) return sendTelegram('No workspace yet — start a build first.');
    const latest = goals[0];
    const files = workspace.listFiles(latest.id);
    if (!files.length) return sendTelegram('Workspace is empty.');
    return sendTelegram(`*Workspace* — ${latest.text.substring(0, 40)}\n\n${files.map(f => `📄 ${f}`).join('\n')}`);
  }

  // ── Command: fix ──
  if (/^fix/i.test(lower)) {
    const { fixFloor } = require('../agents/steven');
    const goals = listGoals();
    for (const g of goals) {
      const floors = listFloors(g.id);
      const blocked = floors.find(f => f.status === 'blocked');
      if (blocked) {
        await sendTelegram(`*Steven* — fixing "${blocked.name}"...`);
        fixFloor(blocked.id).catch(e => sendTelegram(`Fix error: ${e.message}`));
        return;
      }
    }
    return sendTelegram('No blocked floors found.');
  }

  // ── Command: build [goal] ──
  const buildMatch = userText.match(/^(?:build|create|make|start|run|hi build)\s+(.+)/i);
  if (buildMatch) {
    const goalText = buildMatch[1].trim();
    const { setSilent } = require('../notify');
    await sendTelegram(`🔨`);
    try {
      const goal = createGoal(goalText);
      addLog(goal.id, null, 'Hermes', `Goal created via Telegram: ${goalText}`);
      setImmediate(async () => {
        try {
          setSilent(true);
          const floors = await runPlanner(goal);
          await runPipeline(goal, floors);
          setSilent(false);
          // Boom — final summary only
          const { listFloors: lf } = require('../db');
          const done = lf(goal.id);
          const live = done.filter(f => f.status === 'live').length;
          const blocked = done.filter(f => f.status === 'blocked').length;
          const files = workspace.listFiles(goal.id);
          await sendTelegram(`✅ *Done*\n${floors.map((f, i) => `${i + 1}. ${f.name}`).join('\n')}\n\n${live}/${floors.length} floors live · ${files.length} files shipped${blocked ? `\n⚠️ ${blocked} blocked` : ''}`);
        } catch (err) {
          setSilent(false);
          sendTelegram(`❌ Build failed: ${err.message}`);
        }
      });
    } catch (err) {
      await sendTelegram(`❌ ${err.message}`);
    }
    return;
  }

  // ── Default: chat with full system context ──
  const model = userModelMod.get();
  const systemCtx = buildSystemContext(model);
  const goals = listGoals();
  let contextMessages = [];

  if (goals.length > 0) {
    const latest = goals[0];
    const floors = listFloors(latest.id);
    const files = workspace.listFiles(latest.id);
    const wsSummary = files.length > 0 ? workspace.getWorkspaceSummary(latest.id) : '';
    if (wsSummary) {
      contextMessages = [
        { role: 'user', content: `[WORKSPACE]\n${wsSummary}\n[/WORKSPACE]` },
        { role: 'assistant', content: 'I have the full workspace loaded.' },
      ];
    }
  }

  contextMessages.push({ role: 'user', content: userText });
  const reply = await hermesChat(contextMessages, systemCtx);
  await sendTelegram(reply.substring(0, 4000));
}

async function startTelegramPolling() {
  console.log('[Telegram] Bot polling started — I am the bot');

  async function poll() {
    try {
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${telegramOffset}&timeout=10`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !data.result.length) return;

      for (const update of data.result) {
        telegramOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(config.telegramChatId)) continue;

        const userText = msg.text;
        console.log(`[Telegram] ← ${userText.substring(0, 80)}`);
        handleTelegramMessage(userText).catch(err =>
          console.error('[Telegram] Handler error:', err.message)
        );
      }
    } catch (err) {
      console.error('[Telegram] Poll error:', err.message);
    }
  }

  setInterval(poll, 3000);
  poll();
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
