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
const fs = require('fs');
const OFFSET_FILE = path.resolve(__dirname, '..', '..', 'data', 'telegram-offset.json');

let telegramOffset = 0;
try { telegramOffset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0; } catch (_) {}

function saveTelegramOffset(off) {
  telegramOffset = off;
  try { fs.writeFileSync(OFFSET_FILE, String(off), 'utf8'); } catch (_) {}
}

function buildSystemContext(model, recentMessages) {
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
You are Hermes, the AI running inside AskElira 3 on the user's machine.
You are responding via Telegram. You ARE the bot.

## Actions You Can Take
- build [goal] → create and start a new pipeline
- status → show all goals with floor counts
- fix → trigger Steven on blocked floors
- continue → resume an incomplete build
- delete → remove a goal
- digest → send daily email now
- files → list workspace files
- claude [task] → delegate a complex task to Claude Code (coding, debugging, file editing)

## System
LLM: ${config.eliraModel} | AgentMail: ${config.hasAgentmail ? `→ ${config.digestEmail}` : 'off'} | Search: ${config.hasTavily ? 'Tavily' : config.hasBrave ? 'Brave' : 'off'}

## Goals (${goals.length})
${goalSummaries}
${userSection}

## Rules — FOLLOW THESE EXACTLY
1. ONE reply per message. Never duplicate.
2. Max 3 lines. No walls of text.
3. NEVER list options or ask "what would you like to do?" — just ACT.
4. If the user sends a number ("1"), resolve from recent conversation and act.
5. "fix" / "continue" → pick the most relevant goal automatically.
6. Do not repeat yourself. Do not send the same information twice.
7. Do not echo back the user's message. Just respond.
${recentMessages && recentMessages.length > 0 ? `
## Recent Conversation
${recentMessages.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Hermes'}: ${m.content.substring(0, 200)}`).join('\n')}` : ''}`;
}

// Tracks whether Hermes is waiting for a "yes" to resume a specific goal
let resumeConfirmState = { waiting: false, goalId: null, goalText: null };
let buildConfirmState = { waiting: false, goalText: null };
let deleteConfirmState = { waiting: false, goalId: null, goalText: null };

function clearResumeConfirm() {
  resumeConfirmState = { waiting: false, goalId: null, goalText: null };
}

function clearDeleteConfirm() {
  deleteConfirmState = { waiting: false, goalId: null, goalText: null };
}

// ── Intent classifier — uses cheap agentModel to understand what the user wants ──
async function classifyIntent(userText, recentMessages) {
  const { chat } = require('../llm');
  const { config } = require('../config');

  const convoContext = recentMessages.slice(-5).map(m =>
    `${m.role === 'user' ? 'User' : 'Hermes'}: ${m.content.substring(0, 150)}`
  ).join('\n');

  const { listGoals, listFloors } = require('../db');
  const goals = listGoals();
  const goalList = goals.slice(0, 5).map((g, i) =>
    `${i + 1}. "${g.text.substring(0, 50)}" [${g.status}]`
  ).join('\n') || 'None';

  const userModel = require('../user-model').get();
  const suggestions = (userModel.suggestedNext || []).slice(0, 3);

  const prompt = `You are an intent classifier for AskElira, a build automation system.
Given the user message and recent conversation, determine what the user wants.

Recent conversation:
${convoContext || '(no history)'}

Queued build suggestions: ${suggestions.length ? suggestions.join(' | ') : 'none'}
Current goals:
${goalList}

User message: "${userText}"

Available intents:
- build: User wants to create/build something NEW. resolved_target = what to build (be specific).
- status: Check status of goals/floors/builds.
- continue: Resume an incomplete/paused goal.
- delete: Remove/trash/nuke a goal. resolved_target = which goal (name or number).
- fix: Fix a blocked floor (trigger Steven).
- digest: Send the daily email digest now.
- files: Show workspace files.
- notifications: View or change notification settings. Includes: stop/mute/silence/disable/enable alerts, change what gets notified, "stop Steven notifications", "mute floor alerts", "silence", etc.
- steven_summary: Check what Steven has been doing recently (activity, history, log).
- claude_code: User wants to use Claude Code for a task — coding, fixing, editing files, or any complex task. Triggers when user says "use claude", "claude code", "ask claude", "let claude handle it", or references Claude Code directly. resolved_target = the task description.
- chat: General conversation, question, or anything that isn't a specific action.
- ambiguous: Intent is genuinely unclear — could be multiple things. Use sparingly — prefer "chat" when in doubt.

CRITICAL RULES:
- If user says "build it", "do it", "make that", "yes build that" — resolve what "it"/"that" refers to from the recent conversation or suggestions. Return intent "build" with the RESOLVED target, not the pronoun.
- If user says "delete that", "remove the last one" — resolve which goal from conversation context. Return intent "delete" with the resolved goal name.
- If user references something vague and you truly cannot determine what they mean, use "ambiguous" and put a natural clarification question in resolved_target.
- For notification-related messages (silence, mute, alerts on/off), always use "notifications".
- Prefer "chat" over "ambiguous" if the message is conversational but not a command.

Return ONLY valid JSON: {"intent":"...","resolved_target":"...","confidence":0.0}
- confidence: 0.0 to 1.0 how sure you are
- resolved_target: the specific thing (goal name, build idea, etc.) or clarification question for ambiguous`;

  try {
    const reply = await chat([{ role: 'user', content: prompt }], {
      model: config.agentModel,
      system: 'You are a fast intent classifier. Return only valid JSON. No explanation.',
      maxTokens: 200,
      agent: 'Hermes',
    });
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        intent: parsed.intent || 'chat',
        resolved_target: parsed.resolved_target || '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    }
  } catch (err) {
    console.error('[Intent] Classifier error:', err.message);
  }
  return { intent: 'chat', resolved_target: '', confidence: 0.3 };
}

async function handleTelegramMessage(userText) {
  const { hermesChat, hermesPlan } = require('../hermes/index');
  const { sendTelegram } = require('../notify');
  const { listGoals, listFloors, createGoal, addLog, addTelegramMessage, getRecentTelegramMessages } = require('../db');
  const { runPlanner } = require('../pipeline/planner');
  const { runPipeline } = require('../pipeline/floor-runner');
  const { triggerNow } = require('../scheduler');
  const workspace = require('../pipeline/workspace');
  const settings  = require('../settings');

  // Store inbound Telegram message
  await addTelegramMessage('user', userText);

  // Fetch recent conversation for context
  const recentMessages = getRecentTelegramMessages(10);

  // Helper: send reply and store it for web UI
  async function tgReply(text) {
    await addTelegramMessage('assistant', text);
    await sendTelegram(text);
  }

  // AGI: learn from this message + update last seen
  const agi = require('../hermes/agi');
  const userModelMod = require('../user-model');
  userModelMod.touch();
  agi.learnFromMessage(userText).catch(() => {});

  // Strip leading / from Telegram commands — treat as natural language for Hermes
  // Only keep / for recognized bot commands (/claude_code, /claude)
  if (userText.startsWith('/') && !/^\/?\s*(?:claude[_ ]?code|claude)\b/i.test(userText)) {
    userText = userText.replace(/^\/+/, '').trim();
  }
  const lower = userText.toLowerCase().trim();

  // ════════════════════════════════════════════════════════════════
  // STEP 1: Check pending confirmation states FIRST (time-sensitive)
  // ════════════════════════════════════════════════════════════════

  if (buildConfirmState.waiting) {
    const confirmed = /^yes|yep|yeah|do it|go ahead|please|build it|start it|i'm sure/i.test(lower);
    if (confirmed) {
      const goalText = buildConfirmState.goalText;
      buildConfirmState = { waiting: false, goalText: null };
      await tgReply(`🔨 Starting: "${goalText}"…`);
      try {
        const goal = createGoal(goalText);
        addLog(goal.id, null, 'Hermes', `Goal confirmed via Telegram: ${goalText}`);
        setImmediate(async () => {
          try {
            const floors = await runPlanner(goal);
            await tgReply(`📋 *Plan ready* — ${floors.length} floors:\n${floors.map((f, i) => `${i + 1}. ${f.name}`).join('\n')}\n\nBuilding now...`);
            await runPipeline(goal, floors);
            const { listFloors: lf } = require('../db');
            const done = lf(goal.id);
            const live = done.filter(f => f.status === 'live').length;
            const blocked = done.filter(f => f.status === 'blocked').length;
            const files = workspace.listFiles(goal.id);
            await tgReply(`✅ *Done*\n${floors.map((f, i) => `${i + 1}. ${f.name}`).join('\n')}\n\n${live}/${floors.length} floors live · ${files.length} files shipped${blocked ? `\n⚠️ ${blocked} blocked` : ''}`);
          } catch (err) {
            tgReply(`❌ Build failed: ${err.message}`);
          }
        });
      } catch (err) {
        await tgReply(`❌ ${err.message}`);
      }
      return;
    } else {
      buildConfirmState = { waiting: false, goalText: null };
      return tgReply('Build cancelled. Say "build [idea]" when ready.');
    }
  }

  if (resumeConfirmState.waiting) {
    const confirmed = /^yes|yep|yeah|do it|go ahead|please|continue|i'm sure/i.test(lower);
    if (confirmed) {
      const goal = listGoals().find(g => g.id === resumeConfirmState.goalId);
      if (goal) {
        clearResumeConfirm();
        const floors = listFloors(goal.id);
        const pending = floors.filter(f => f.status !== 'live');
        tgReply(`🔨 Resuming — ${pending.length} floors remaining for "${goal.text.substring(0, 40)}"…`);
        setImmediate(async () => {
          try {
            await runPipeline(goal, pending);
          } catch (err) {
            tgReply(`❌ Resume failed: ${err.message}`);
          }
        });
        return;
      }
    }
    clearResumeConfirm();
    return tgReply('Okay, cancelled. Say "continue" again when you\'re ready.');
  }

  if (deleteConfirmState.waiting) {
    const confirmed = /^yes|yep|yeah|do it|delete it|confirm|i'm sure/i.test(lower);
    if (confirmed) {
      const { deleteGoal } = require('../db');
      const goal = deleteGoal(deleteConfirmState.goalId);
      if (goal) {
        workspace.deleteWorkspace(deleteConfirmState.goalId);
        clearDeleteConfirm();
        return tgReply(`🗑 Deleted "${goal.text.substring(0, 50)}" — goal, floors, logs, and workspace removed.`);
      }
      clearDeleteConfirm();
      return tgReply('Goal was already removed.');
    }
    clearDeleteConfirm();
    return tgReply('Delete cancelled.');
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 2: Fast-path for unambiguous single-word/phrase commands
  // ════════════════════════════════════════════════════════════════

  if (/^(status|goals|update|what.s running|show goals)$/i.test(lower)) {
    const goals = listGoals();
    if (!goals.length) return tgReply('No goals yet. Send me something to build!');
    const lines = goals.slice(0, 5).map(g => {
      const floors = listFloors(g.id);
      const live = floors.filter(f => f.status === 'live').length;
      const blocked = floors.filter(f => f.status === 'blocked').length;
      const icon = g.status === 'goal_met' ? '✅' : g.status === 'blocked' ? '🔴' : g.status === 'building' ? '🔨' : '⏳';
      return `${icon} ${g.text.substring(0, 45)}\n   ${live}/${floors.length} live${blocked ? `, ${blocked} blocked` : ''}`;
    });
    return tgReply(`*Goals*\n\n${lines.join('\n\n')}`);
  }

  if (/^(digest|send digest|send email|news)$/i.test(lower)) {
    await tgReply('Sending digest now...');
    triggerNow().catch(e => tgReply(`Digest error: ${e.message}`));
    return;
  }

  if (/^(files|workspace|show files|ls)$/i.test(lower)) {
    const goals = listGoals();
    if (!goals.length) return tgReply('No workspace yet — start a build first.');
    const latest = goals[0];
    const files = workspace.listFiles(latest.id);
    if (!files.length) return tgReply('Workspace is empty.');
    return tgReply(`*Workspace* — ${latest.text.substring(0, 40)}\n\n${files.map(f => `📄 ${f}`).join('\n')}`);
  }

  if (/^fix$/i.test(lower)) {
    const { fixFloor } = require('../agents/steven');
    const goals = listGoals();
    for (const g of goals) {
      const floors = listFloors(g.id);
      const blocked = floors.find(f => f.status === 'blocked');
      if (blocked) {
        await tgReply(`*Steven* — fixing "${blocked.name}"...`);
        fixFloor(blocked.id).catch(e => tgReply(`Fix error: ${e.message}`));
        return;
      }
    }
    return tgReply('No blocked floors found.');
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 2b: Numbered responses ("1", "2", "3") — resolve from context
  // ════════════════════════════════════════════════════════════════

  const numMatch = lower.match(/^(\d)\.?$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    const incompleteGoals = listGoals().filter(g =>
      g.status !== 'goal_met' && g.status !== 'completed'
    );
    if (idx >= 0 && idx < incompleteGoals.length) {
      const target = incompleteGoals[idx];
      const floors = listFloors(target.id);
      const blocked = floors.find(f => f.status === 'blocked');
      if (blocked) {
        await tgReply(`Fixing "${blocked.name}" for "${target.text.substring(0, 40)}"...`);
        const { fixFloor } = require('../agents/steven');
        fixFloor(blocked.id).catch(e => tgReply(`Fix error: ${e.message}`));
        return;
      }
      const pending = floors.filter(f => f.status !== 'live');
      if (pending.length > 0) {
        await tgReply(`Resuming "${target.text.substring(0, 40)}" — ${pending.length} floors remaining...`);
        setImmediate(async () => {
          try { await runPipeline(target, pending); }
          catch (err) { tgReply(`Pipeline error: ${err.message}`); }
        });
        return;
      }
      return tgReply(`"${target.text.substring(0, 40)}" — all floors live!`);
    }
  }

  // ── Fast-path: Claude Code ──
  const claudeMatch = userText.match(/^\/?\s*(?:claude[_ ]?code|claude|ask claude|use claude)\s*(.*)/i);
  if (claudeMatch) {
    const task = claudeMatch[1].trim() || 'What can you help with?';
    const { claudeCode } = require('../claude-code');
    const goals = listGoals();
    let targetGoal = goals.find(g => {
      const words = g.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      return words.some(w => task.toLowerCase().includes(w));
    }) || goals[0];
    const cwd = targetGoal ? workspace.getWorkspacePath(targetGoal.id) : process.cwd();
    await tgReply(`Claude Code: "${task.substring(0, 60)}"...`);
    setImmediate(async () => {
      try {
        const result = await claudeCode(task, { cwd });
        if (result.success) {
          const output = result.output.length > 3500 ? result.output.substring(0, 3500) + '\n...(truncated)' : result.output;
          await tgReply(`*Claude Code* (${Math.round(result.durationMs / 1000)}s)\n\n${output}`);
        } else {
          await tgReply(`Claude Code failed: ${result.error.substring(0, 500)}`);
        }
      } catch (err) { await tgReply(`Claude Code error: ${err.message}`); }
    });
    return;
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 3: LLM intent classifier (everything else)
  // ════════════════════════════════════════════════════════════════

  const classification = await classifyIntent(userText, recentMessages);
  console.log(`[Intent] "${userText.substring(0, 40)}" → ${classification.intent} (${classification.confidence}) target="${classification.resolved_target?.substring(0, 40) || ''}"`);

  // ── Disambiguation: only ask if genuinely ambiguous with very low confidence ──
  // At medium confidence, fall through to chat instead of blocking with "I'm not sure"
  if (classification.intent === 'ambiguous' && classification.confidence < 0.4) {
    const question = classification.resolved_target || "I'm not sure what you'd like me to do. Could you be more specific?";
    return tgReply(`🤔 ${question}`);
  }
  // Reclassify low-confidence non-ambiguous intents as chat to avoid wrong routing
  if (classification.confidence < 0.3 && classification.intent !== 'chat') {
    classification.intent = 'chat';
  }

  // ── Route by intent ──

  if (classification.intent === 'build') {
    const goalText = classification.resolved_target || userText.replace(/^(build|create|make|start)\s*/i, '').trim();
    if (!goalText || goalText.length < 3) {
      return tgReply('What would you like me to build? Be specific.');
    }

    // LLM gate: confirm this is a real build request
    const model = userModelMod.get();
    const systemCtx = buildSystemContext(model, recentMessages);
    buildConfirmState = { waiting: true, goalText: goalText };
    return tgReply(
      `🤖 Hermès wants to build: *${goalText}*\n\n` +
      `Say *yes* to confirm and start building, or anything else to cancel.`
    );
  }

  if (classification.intent === 'continue') {
    const incompleteGoals = listGoals().filter(g =>
      g.status !== 'goal_met' && g.status !== 'completed'
    );
    if (!incompleteGoals.length) {
      return tgReply('No incomplete goals to resume.');
    }

    // Try to match from classifier's resolved_target
    let target = null;
    const resolvedName = (classification.resolved_target || '').toLowerCase();
    if (resolvedName) {
      target = incompleteGoals.find(g => g.text.toLowerCase().includes(resolvedName));
    }
    // Try user's message text for goal keywords
    if (!target) {
      const msgLower = userText.toLowerCase();
      target = incompleteGoals.find(g => {
        const words = g.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return words.some(w => msgLower.includes(w));
      });
    }
    // Fallback: check recent conversation
    if (!target && recentMessages.length > 0) {
      const recentText = recentMessages.slice(-6).map(m => m.content).join(' ').toLowerCase();
      target = incompleteGoals.find(g => recentText.includes(g.text.substring(0, 30).toLowerCase()));
    }
    if (!target) target = incompleteGoals[0];

    const floors = listFloors(target.id);
    const blocked = floors.find(f => f.status === 'blocked');
    const pending = floors.filter(f => f.status !== 'live');

    // If there's a blocked floor, fix it first
    if (blocked) {
      await tgReply(`Fixing blocked floor "${blocked.name}" in "${target.text.substring(0, 40)}"...`);
      const { fixFloor } = require('../agents/steven');
      fixFloor(blocked.id).catch(e => tgReply(`Fix error: ${e.message}`));
      return;
    }

    // Otherwise resume pipeline — no confirmation needed when user explicitly asked
    if (pending.length > 0) {
      await tgReply(`Resuming "${target.text.substring(0, 40)}" — ${pending.length} floors remaining...`);
      setImmediate(async () => {
        try { await runPipeline(target, pending); }
        catch (err) { tgReply(`Pipeline error: ${err.message}`); }
      });
      return;
    }

    return tgReply(`"${target.text.substring(0, 40)}" — all floors live!`);
  }

  if (classification.intent === 'delete') {
    const goals = listGoals();
    if (!goals.length) return tgReply('No goals to delete.');

    let target = null;
    const resolvedName = (classification.resolved_target || '').toLowerCase();

    // Try to match by resolved name
    if (resolvedName) {
      // Check for number reference
      const numMatch = resolvedName.match(/#?(\d+)/);
      if (numMatch) {
        target = goals[parseInt(numMatch[1]) - 1];
      }
      if (!target) {
        target = goals.find(g => g.text.toLowerCase().includes(resolvedName));
      }
    }

    if (!target) {
      const lines = goals.slice(0, 8).map((g, i) => {
        const floors = listFloors(g.id);
        const live = floors.filter(f => f.status === 'live').length;
        return `${i + 1}. ${g.text.substring(0, 45)} (${g.status}, ${live}/${floors.length})`;
      });
      return tgReply(`Which goal to delete?\n\n${lines.join('\n')}\n\nSay "delete #1" or "delete [name]".`);
    }

    const floors = listFloors(target.id);
    deleteConfirmState = { waiting: true, goalId: target.id, goalText: target.text };
    return tgReply(
      `⚠️ *Delete this goal?*\n\n"${target.text.substring(0, 60)}"\n` +
      `${floors.length} floors · ${floors.filter(f => f.status === 'live').length} live\n\n` +
      `This removes the goal, all floors, logs, and workspace files permanently.\n\n` +
      `Reply *yes* to confirm.`
    );
  }

  if (classification.intent === 'fix') {
    const { fixFloor } = require('../agents/steven');
    const goals = listGoals();
    // Try to match the goal user is talking about
    let targetGoal = null;
    const resolvedName = (classification.resolved_target || '').toLowerCase();
    if (resolvedName) {
      targetGoal = goals.find(g => g.text.toLowerCase().includes(resolvedName));
    }
    if (!targetGoal) {
      // Check user's message for goal keywords
      const msgLower = userText.toLowerCase();
      targetGoal = goals.find(g => {
        const words = g.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return words.some(w => msgLower.includes(w));
      });
    }
    // Search in the matched goal first, then all goals
    const searchOrder = targetGoal ? [targetGoal, ...goals.filter(g => g.id !== targetGoal.id)] : goals;
    for (const g of searchOrder) {
      const floors = listFloors(g.id);
      const blocked = floors.find(f => f.status === 'blocked');
      if (blocked) {
        await tgReply(`Fixing "${blocked.name}" in "${g.text.substring(0, 40)}"...`);
        fixFloor(blocked.id).catch(e => tgReply(`Fix error: ${e.message}`));
        return;
      }
    }
    return tgReply('No blocked floors found.');
  }

  if (classification.intent === 'status') {
    const goals = listGoals();
    if (!goals.length) return tgReply('No goals yet. Send me something to build!');
    const lines = goals.slice(0, 5).map(g => {
      const floors = listFloors(g.id);
      const live = floors.filter(f => f.status === 'live').length;
      const blocked = floors.filter(f => f.status === 'blocked').length;
      const icon = g.status === 'goal_met' ? '✅' : g.status === 'blocked' ? '🔴' : g.status === 'building' ? '🔨' : '⏳';
      return `${icon} ${g.text.substring(0, 45)}\n   ${live}/${floors.length} live${blocked ? `, ${blocked} blocked` : ''}`;
    });
    return tgReply(`*Goals*\n\n${lines.join('\n\n')}`);
  }

  if (classification.intent === 'digest') {
    await tgReply('Sending digest now...');
    triggerNow().catch(e => tgReply(`Digest error: ${e.message}`));
    return;
  }

  if (classification.intent === 'files') {
    const goals = listGoals();
    if (!goals.length) return tgReply('No workspace yet — start a build first.');
    const latest = goals[0];
    const files = workspace.listFiles(latest.id);
    if (!files.length) return tgReply('Workspace is empty.');
    return tgReply(`*Workspace* — ${latest.text.substring(0, 40)}\n\n${files.map(f => `📄 ${f}`).join('\n')}`);
  }

  if (classification.intent === 'notifications') {
    const s = settings.get();
    const n = s.notifications;

    var changed = false;
    var on  = / on\b| enable/i.test(lower);
    var off = / off\b| disable/i.test(lower);

    // Steven-specific MUST come before the catch-all "stop.*notif" so
    // "stop Steven fixing notifications" hits this, not "silence all"
    if (/steven.*(off|on|stop|disable|enable|mute|silence)|(off|on|stop|disable|enable|mute|silence).*steven/i.test(lower)) {
      var stOn = /steven.*(on|enable)|(on|enable).*steven/i.test(lower);
      settings.update({ notifications: { ...n, stevenAlerts: !!stOn } });
      changed = stOn ? 'Steven alerts enabled.' : 'Steven alerts disabled.';
    } else if (/floor.*(on|off|enable|disable|stop|mute)|(enable|disable|stop|mute).*floor/i.test(lower)) {
      var flOn = /floor.*(on|enable)|(on|enable).*floor/i.test(lower);
      if (flOn) { settings.update({ notifications: { ...n, floorLive: true, floorBlocked: true } }); changed = 'Floor notifications ON'; }
      else      { settings.update({ notifications: { ...n, floorLive: false, floorBlocked: false } }); changed = 'Floor notifications OFF'; }
    } else if (/only.*build|build.*only/i.test(lower)) {
      settings.update({ notifications: { floorLive: false, floorBlocked: false, buildComplete: true, stevenAlerts: false } });
      changed = 'Only build-complete notifications ON';
    } else if (/stop.*notif|silence.*notif|shut up|no.*notif|mute.*notif/i.test(lower)) {
      settings.update({ notifications: { floorLive: false, floorBlocked: false, buildComplete: false, stevenAlerts: false } });
      changed = 'All notifications silenced.';
    } else if (/all.*notif|everything|enable.*notif|turn.*on/i.test(lower)) {
      settings.update({ notifications: { floorLive: true, floorBlocked: true, buildComplete: true, stevenAlerts: true } });
      changed = 'All notifications ON';
    }

    if (changed) return tgReply('✅ ' + changed);

    const ntfy = (v) => v ? '🔔' : '🔕';
    return tgReply(
      `*Notification Settings*\n\n` +
      `${ntfy(n.floorLive)} Floor live notifications\n` +
      `${ntfy(n.floorBlocked)} Floor blocked notifications\n` +
      `${ntfy(n.buildComplete)} Build complete notification\n` +
      `${ntfy(n.stevenAlerts)} Steven fix alerts\n\n` +
      `Say "silence notifications" or "only ping when done" to change.`
    );
  }

  if (classification.intent === 'steven_summary') {
    const fs = require('fs');
    const STATE_FILE = path.resolve(__dirname, '..', '..', 'data', 'heartbeat-state.json');
    let stateData = {};
    try { stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
    const now = Date.now();
    const sixHoursAgo = now - (6 * 60 * 60 * 1000);
    const fixes = Object.entries(stateData).filter(([k, v]) => v.lastFixAttempt && v.lastFixAttempt > sixHoursAgo);
    if (!fixes.length) return tgReply('Steven has been quiet — no auto-fixes in the last 6 hours. 🛌');
    const lines = fixes.map(([k, v]) => {
      const icon = v.lastFixResult === 'fixed' ? '✅' : v.lastFixResult === 'failed' ? '⚠️' : '❌';
      const ago = Math.round((now - v.lastFixAttempt) / 60000);
      return `${icon} ${v.floorName || k.substring(0, 8)} — ${v.lastFixResult} (${ago}m ago)`;
    });
    return tgReply(`*Steven Summary (6h)*\n\n${lines.join('\n')}`);
  }

  // ── Claude Code: delegate complex tasks to Claude ──
  if (classification.intent === 'claude_code') {
    const { claudeCode } = require('../claude-code');
    const task = classification.resolved_target || userText;

    // Find relevant goal for workspace context
    const goals = listGoals();
    let targetGoal = null;
    const msgLower = userText.toLowerCase();
    targetGoal = goals.find(g => {
      const words = g.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      return words.some(w => msgLower.includes(w));
    });
    if (!targetGoal) targetGoal = goals[0];

    const cwd = targetGoal ? workspace.getWorkspacePath(targetGoal.id) : process.cwd();
    await tgReply(`Sending to Claude Code: "${task.substring(0, 60)}"...`);

    setImmediate(async () => {
      try {
        const result = await claudeCode(task, { cwd });
        if (result.success) {
          const output = result.output.length > 3500
            ? result.output.substring(0, 3500) + '\n\n... (truncated)'
            : result.output;
          await tgReply(`*Claude Code* (${Math.round(result.durationMs / 1000)}s)\n\n${output}`);
        } else {
          await tgReply(`Claude Code failed: ${result.error.substring(0, 500)}`);
        }
        if (targetGoal) {
          addLog(targetGoal.id, null, 'Elira', `Claude Code task: ${task.substring(0, 100)} — ${result.success ? 'success' : 'failed'} (${result.durationMs}ms)`);
        }
      } catch (err) {
        await tgReply(`Claude Code error: ${err.message}`);
      }
    });
    return;
  }

  // ── Default: chat with full system context ──
  const model = userModelMod.get();
  const systemCtx = buildSystemContext(model, recentMessages);
  const goals = listGoals();
  let contextMessages = [];

  if (goals.length > 0) {
    // Find the goal the user is most likely talking about
    let relevantGoal = null;
    const msgLower = userText.toLowerCase();
    const resolved = (classification.resolved_target || '').toLowerCase();

    // Try resolved_target from classifier
    if (resolved) {
      relevantGoal = goals.find(g => g.text.toLowerCase().includes(resolved));
    }
    // Try matching keywords from user message against goal texts
    if (!relevantGoal) {
      relevantGoal = goals.find(g => {
        const words = g.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return words.some(w => msgLower.includes(w));
      });
    }
    // Fallback to most recent goal
    if (!relevantGoal) relevantGoal = goals[0];

    const floors = listFloors(relevantGoal.id);
    const files = workspace.listFiles(relevantGoal.id);
    const floorSummary = floors.map(f => `F${f.floor_number} "${f.name}" [${f.status}]${f.vex2_score != null ? ' vex2:' + f.vex2_score : ''}`).join('\n');
    const wsSummary = files.length > 0 ? workspace.getWorkspaceSummary(relevantGoal.id) : '';

    const goalContext = [
      `## Active Goal: "${relevantGoal.text}"`,
      `Status: ${relevantGoal.status} | ${floors.filter(f=>f.status==='live').length}/${floors.length} floors live`,
      `\n### Floors\n${floorSummary}`,
      wsSummary ? `\n### Workspace Files\n${wsSummary}` : '',
    ].join('\n');

    contextMessages = [
      { role: 'user', content: `[CONTEXT]\n${goalContext}\n[/CONTEXT]\n\nUse this to answer questions about this build.` },
      { role: 'assistant', content: 'I have the goal context loaded.' },
    ];
  }

  contextMessages.push({ role: 'user', content: userText });
  const reply = await hermesChat(contextMessages, systemCtx);
  await tgReply(reply.substring(0, 4000));
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
        saveTelegramOffset(update.update_id + 1);
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
