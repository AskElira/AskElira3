const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { listGoals, getGoal, listFloors, getFloor, getLogs, addLog, getTelegramMessages, deleteGoal, addWebChatMessage, getWebChatMessages } = require('../db');
const { hermesChat, hermesRoute } = require('../hermes/index');
const { runPlanner } = require('../pipeline/planner');
const { runPipeline } = require('../pipeline/floor-runner');
const workspace = require('../pipeline/workspace');
const { fixFloor } = require('../agents/steven');
const { config } = require('../config');

const router = express.Router();

// ── Auth middleware ──
router.use('/api', (req, res, next) => {
  if (!config.hasApiToken) return next();
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${config.apiToken}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Rate limiting ──
const goalCreationLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many goals created. Try again in a minute.' },
});

// ── Goals ──

// List all goals with floor counts
router.get('/api/goals', (req, res) => {
  try {
    const goals = listGoals();
    const enriched = goals.map(g => {
      const floors = listFloors(g.id);
      const live = floors.filter(f => f.status === 'live').length;
      const blocked = floors.filter(f => f.status === 'blocked').length;
      return { ...g, floorCount: floors.length, floorsLive: live, floorsBlocked: blocked };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a goal, plan, and start pipeline async
router.post('/api/goals', goalCreationLimit, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Goal text is required' });
    }

    const goal = await hermesRoute(text.trim());
    res.json(goal);

    // Run planner + pipeline async (non-blocking)
    setImmediate(async () => {
      try {
        const floors = await runPlanner(goal);
        await runPipeline(goal, floors);
      } catch (err) {
        console.error('[Routes] Pipeline error:', err.message);
        addLog(goal.id, null, 'Hermes', `Pipeline error: ${err.message}`);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a goal + floors + logs + workspace
router.delete('/api/goals/:id', (req, res) => {
  try {
    const goal = deleteGoal(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    workspace.deleteWorkspace(req.params.id);
    console.log(`[Routes] Deleted goal: ${goal.text.substring(0, 60)}`);
    res.json({ deleted: true, id: goal.id, text: goal.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get goal + floors + workspace file list
router.get('/api/goals/:id', (req, res) => {
  try {
    const goal = getGoal(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const floors = listFloors(goal.id);
    const files = workspace.listFiles(goal.id);
    res.json({ ...goal, floors, workspaceFiles: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE: stream live logs + status changes for a goal
router.get('/api/goals/:id/stream', (req, res) => {
  const goal = getGoal(req.params.id);
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const TERMINAL_STATUSES = new Set(['goal_met', 'partial', 'blocked']);
  const POLL_MS = 1500;

  // Track what we've already sent
  let lastLogId = 0;
  let lastFloorStatuses = {};
  let lastGoalStatus = goal.status;

  // Seed last log ID without sending historical logs
  try {
    const existing = getLogs({ goalId: goal.id, limit: 1 });
    if (existing.length > 0) lastLogId = existing[0].id;
  } catch (_) {}

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function poll() {
    try {
      const currentGoal = getGoal(req.params.id);
      if (!currentGoal) return;

      // New logs
      const newLogs = getLogs({ goalId: req.params.id, limit: 50 })
        .filter(l => l.id > lastLogId)
        .reverse(); // oldest first
      for (const log of newLogs) {
        sendEvent('log', { id: log.id, agent: log.agent, message: log.message, floorId: log.floor_id, createdAt: log.created_at });
        lastLogId = Math.max(lastLogId, log.id);
      }

      // Floor status changes
      const floors = listFloors(req.params.id);
      for (const floor of floors) {
        const prev = lastFloorStatuses[floor.id];
        if (prev !== floor.status) {
          sendEvent('status', { type: 'floor', floorNumber: floor.floor_number, floorName: floor.name, status: floor.status, step: floor.current_step });
          lastFloorStatuses[floor.id] = floor.status;
        }
      }

      // Goal status change
      if (currentGoal.status !== lastGoalStatus) {
        sendEvent('status', { type: 'goal', status: currentGoal.status });
        lastGoalStatus = currentGoal.status;
      }

      // Terminal — close stream
      if (TERMINAL_STATUSES.has(currentGoal.status)) {
        sendEvent('done', { goalStatus: currentGoal.status });
        clearInterval(timer);
        res.end();
      }
    } catch (_) {}
  }

  const timer = setInterval(poll, POLL_MS);
  req.on('close', () => clearInterval(timer));
});

// Trigger Steven to fix a blocked floor for a goal
router.post('/api/goals/:id/fix', async (req, res) => {
  try {
    const goal = getGoal(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const floors = listFloors(goal.id);
    const blocked = floors.find(f => f.status === 'blocked');
    if (!blocked) return res.status(400).json({ error: 'No blocked floors to fix' });

    res.json({ message: 'Fix started', floorId: blocked.id, floorName: blocked.name });

    setImmediate(async () => {
      try {
        await fixFloor(blocked.id, req.body.errorReport);
      } catch (err) {
        console.error('[Routes] Fix error:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace Files ──

// List workspace files for a goal
router.get('/api/goals/:id/files', (req, res) => {
  try {
    const files = workspace.listFiles(req.params.id);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read a workspace file (wildcard path)
router.get('/api/goals/:id/files/*', (req, res) => {
  try {
    const filePath = req.params[0];
    if (!filePath) return res.status(400).json({ error: 'File path required' });
    if (filePath.includes('..') || path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    const content = workspace.readFile(req.params.id, filePath);
    if (content === null) return res.status(404).json({ error: 'File not found' });
    res.type('text/plain').send(content);
  } catch (err) {
    if (err.message?.includes('Path traversal')) return res.status(400).json({ error: 'Invalid file path' });
    res.status(500).json({ error: err.message });
  }
});

// Workspace summary
router.get('/api/workspace/:goalId', (req, res) => {
  try {
    const summary = workspace.getWorkspaceSummary(req.params.goalId);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Floors ──

// Get floor details + logs
router.get('/api/floors/:id', (req, res) => {
  try {
    const floor = getFloor(req.params.id);
    if (!floor) return res.status(404).json({ error: 'Floor not found' });
    const logs = getLogs({ floorId: floor.id, limit: 50 });
    res.json({ ...floor, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Steven fix for a specific floor
router.post('/api/floors/:id/fix', async (req, res) => {
  try {
    const floor = getFloor(req.params.id);
    if (!floor) return res.status(404).json({ error: 'Floor not found' });

    res.json({ message: 'Fix started', floorId: floor.id, floorName: floor.name });

    setImmediate(async () => {
      try {
        await fixFloor(floor.id, req.body.errorReport);
      } catch (err) {
        console.error('[Routes] Fix error:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually run pipeline for a goal
router.post('/api/goals/:id/run', async (req, res) => {
  try {
    const goal = getGoal(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    let floors = listFloors(goal.id);
    if (floors.length === 0) {
      floors = await runPlanner(goal);
    }

    res.json({ message: 'Pipeline started', goalId: goal.id, floors: floors.length });

    setImmediate(async () => {
      try {
        const pendingFloors = listFloors(goal.id).filter(f => f.status !== 'live');
        await runPipeline(goal, pendingFloors);
      } catch (err) {
        console.error('[Routes] Pipeline error:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logs ──

router.get('/api/logs', (req, res) => {
  try {
    const { goalId, agent } = req.query;
    const logs = getLogs({ goalId, agent, limit: 200 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Telegram Messages ──

router.get('/api/telegram-messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const messages = getTelegramMessages(limit);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat ──

// Get persisted web chat history
router.get('/api/chat-messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = getWebChatMessages(limit);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/chat', async (req, res) => {
  try {
    const { messages, goalId } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Persist the latest user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) addWebChatMessage('user', lastUserMsg.content);

    // Inject workspace context if goalId provided
    let contextMessages = messages;
    if (goalId) {
      const goal = getGoal(goalId);
      const floors = goal ? listFloors(goalId) : [];
      const files = workspace.listFiles(goalId);
      const summary = files.length > 0 ? workspace.getWorkspaceSummary(goalId) : '';
      const ctx = [
        `## Active Goal\n"${goal ? goal.text : goalId}"`,
        `## Floors (${floors.length})\n${floors.map(f => `- F${f.floor_number} ${f.name}: ${f.status}`).join('\n')}`,
        summary ? `## Workspace Files\n${summary}` : '## Workspace\nNo files yet.'
      ].join('\n\n');

      // Prepend context as a system-style user message before the conversation
      contextMessages = [
        { role: 'user', content: `[CONTEXT]\n${ctx}\n[/CONTEXT]\n\nUse this context to answer questions about the build.` },
        { role: 'assistant', content: 'Got it — I have full context on this build. What do you need?' },
        ...messages
      ];
    }

    const reply = await hermesChat(contextMessages);

    // Persist the assistant reply
    addWebChatMessage('assistant', reply);

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Digest ──

router.post('/api/digest/send', async (req, res) => {
  try {
    const { triggerNow } = require('../scheduler');
    res.json({ message: 'Digest sending...' });
    setImmediate(() => triggerNow().catch(err => console.error('[Digest] Error:', err.message)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User Model ──

router.get('/api/user-model', (req, res) => {
  try {
    const userModel = require('../user-model');
    res.json(userModel.get());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/user-model', (req, res) => {
  try {
    const userModel = require('../user-model');
    const updated = userModel.update(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ──

router.get('/api/stats/llm', (req, res) => {
  try {
    const { getLlmStats } = require('../db');
    res.json(getLlmStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/stats/metrics', (req, res) => {
  try {
    const { getMetricsSummary } = require('../db');
    res.json(getMetricsSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/stats/circuits', (req, res) => {
  try {
    const { getAllBreakers } = require('../circuit-breaker');
    res.json(getAllBreakers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Status ──

router.get('/api/status', (req, res) => {
  try {
    const goals = listGoals();
    const totalFloors = goals.reduce((acc, g) => acc + listFloors(g.id).length, 0);
    const { getUsageSummary } = require('../llm');
    const usage = getUsageSummary();
    res.json({
      llm: config.hasLlm,
      llmProvider: config.isAnthropic ? 'Anthropic' : 'OpenAI-compatible',
      eliraModel: config.eliraModel,
      agentModel: config.agentModel,
      telegram: config.hasTelegram,
      webSearch: config.hasTavily ? 'Tavily' : config.hasBrave ? 'Brave' : 'None',
      agentmail: config.hasAgentmail,
      digestEmail: config.hasAgentmail ? config.digestEmail : null,
      version: '3.0.0',
      goalCount: goals.length,
      floorCount: totalFloors,
      hermesMode: 'unified',
      llmBudgetPct: usage.budgetPct,
      llmTotalCalls: usage.calls,
      uptime: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──

router.get('/api/settings', (req, res) => {
  try {
    const settings = require('../settings');
    res.json(settings.get());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/settings', (req, res) => {
  try {
    const settings = require('../settings');
    const updated = settings.update(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
