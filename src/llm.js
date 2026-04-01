const fs = require('fs');
const path = require('path');
const { config } = require('./config');

// ── Usage tracking ──────────────────────────────────────────────────────────
const USAGE_FILE = path.resolve(__dirname, '..', 'data', 'usage.json');
const USAGE_BUDGET = parseInt(process.env.TOKEN_BUDGET || '5000000', 10); // default 5M tokens
const USAGE_ALERT_THRESHOLD = 0.9;

let _usageAlerted = false;

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return { totalTokens: 0, calls: 0, lastReset: new Date().toISOString() };
  }
}

function saveUsage(usage) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

function trackUsage(tokensUsed) {
  const usage = loadUsage();
  usage.totalTokens += tokensUsed;
  usage.calls += 1;
  usage.lastUpdated = new Date().toISOString();
  saveUsage(usage);

  const pct = usage.totalTokens / USAGE_BUDGET;
  if (pct >= USAGE_ALERT_THRESHOLD && !_usageAlerted) {
    _usageAlerted = true;
    const used = Math.round(pct * 100);
    console.warn(`[LLM] ⚠️ Usage at ${used}% of budget (${usage.totalTokens.toLocaleString()} / ${USAGE_BUDGET.toLocaleString()} tokens)`);
    // Send Telegram alert (non-blocking)
    try {
      const { sendTelegram } = require('./notify');
      sendTelegram(`⚠️ *Usage Alert*\n\nMiniMax token usage is at *${used}%* of budget.\n${usage.totalTokens.toLocaleString()} / ${USAGE_BUDGET.toLocaleString()} tokens used.\n\nSwitching chat/status to local model. Building tasks stay on MiniMax.`).catch(() => {});
    } catch {}
  }
  return pct;
}

function isOverThreshold() {
  const usage = loadUsage();
  return (usage.totalTokens / USAGE_BUDGET) >= USAGE_ALERT_THRESHOLD;
}

// Returns true for building tasks that must stay on MiniMax
function isBuildingTask(opts = {}) {
  return !!opts.isBuildingTask;
}

// Local Ollama fallback for chat-only tasks
async function ollamaChat(messages, { model = 'qwen2.5:7b', system, maxTokens = 2048 } = {}) {
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: allMessages,
      stream: false,
      options: { num_predict: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return stripThinking(data.message?.content || '');
}

/**
 * Send a chat completion request to the configured LLM provider.
 * Supports Anthropic Messages API and OpenAI-compatible API.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} opts
 * @param {string} [opts.model]
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens=4096]
 * @returns {Promise<string>} assistant reply text
 */
async function withRetry(fn, retries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = /429|500|503/.test(err.message);
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`[LLM] Retry ${attempt}/${retries} in ${delay}ms — ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function stripThinking(text) {
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/TOOL_CALL[\s\S]*?\[\/TOOLCALL\]/gi, '')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '')
    .replace(/<minimax:toolcall>[\s\S]*?<\/minimax:toolcall>/gi, '')
    .replace(/```tool[\s\S]*?```/gi, '')
    .trim();
  // Unwrap <answer>...</answer> — some models wrap final output in this tag
  const answerMatch = out.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (answerMatch) out = answerMatch[1].trim();
  return out;
}

async function chat(messages, { model, system, maxTokens = 4096, isBuildingTask: building = false, goalId, floorId, agent } = {}) {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY not configured');
  }

  // Route to local Ollama when over 90% budget, unless it's a building task
  if (!building && isOverThreshold()) {
    try {
      console.log('[LLM] Over 90% budget — routing chat to local Ollama');
      return await ollamaChat(messages, { system, maxTokens });
    } catch (err) {
      console.warn('[LLM] Ollama fallback failed, using MiniMax:', err.message);
    }
  }

  const resolvedModel = model || config.agentModel;

  if (config.isAnthropic && !config.isOpenAI) {
    return anthropicChat(messages, { model: resolvedModel, system, maxTokens, goalId, floorId, agent });
  }
  return openaiChat(messages, { model: resolvedModel, system, maxTokens, goalId, floorId, agent });
}

async function anthropicChat(messages, { model, system, maxTokens, goalId, floorId, agent }) {
  const start = Date.now();
  const baseUrl = config.llmBaseUrl.replace(/\/v1\/?$/, '');
  const url = `${baseUrl}/v1/messages`;

  // Anthropic expects messages without system role; system is a top-level param
  const filteredMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: filteredMessages,
  };
  if (system) body.system = system;

  const res = await withRetry(() => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }).then(async r => {
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Anthropic API error ${r.status}: ${errText}`);
    }
    return r;
  }));

  const data = await res.json();
  if (!data.content || !data.content.length) {
    throw new Error('Anthropic returned empty content');
  }
  try {
    const { logLlmCall, incrementGoalLlmUsage } = require('./db');
    const tokensIn = data.usage?.input_tokens || 0;
    const tokensOut = data.usage?.output_tokens || 0;
    logLlmCall({
      goalId: goalId || null, floorId: floorId || null, agent: agent || 'unknown',
      model: model, tokensIn, tokensOut, totalTokens: tokensIn + tokensOut,
      durationMs: Date.now() - start,
    });
    if (goalId) incrementGoalLlmUsage(goalId, tokensIn + tokensOut);
  } catch (_) {}
  return stripThinking(data.content[0].text);
}

async function openaiChat(messages, { model, system, maxTokens, goalId, floorId, agent }) {
  const start = Date.now();
  const baseUrl = config.llmBaseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const allMessages = [];
  if (system) {
    allMessages.push({ role: 'system', content: system });
  }
  allMessages.push(...messages);

  const body = {
    model,
    max_tokens: maxTokens,
    messages: allMessages,
  };

  const res = await withRetry(() => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  }).then(async r => {
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`OpenAI API error ${r.status}: ${errText}`);
    }
    return r;
  }));

  const data = await res.json();
  if (!data.choices || !data.choices.length) {
    throw new Error('OpenAI returned empty choices');
  }
  if (data.usage?.total_tokens) {
    trackUsage(data.usage.total_tokens);
    try {
      const { logLlmCall, incrementGoalLlmUsage } = require('./db');
      logLlmCall({
        goalId: goalId || null, floorId: floorId || null, agent: agent || 'unknown',
        model: model, tokensIn: data.usage.prompt_tokens || 0,
        tokensOut: data.usage.completion_tokens || 0, totalTokens: data.usage.total_tokens,
        durationMs: Date.now() - start,
      });
      if (goalId) incrementGoalLlmUsage(goalId, data.usage.total_tokens);
    } catch (_) {}
  }
  return stripThinking(data.choices[0].message.content);
}

function getUsageSummary() {
  const usage = loadUsage();
  return {
    totalTokens: usage.totalTokens || 0,
    calls: usage.calls || 0,
    budgetPct: Math.round(((usage.totalTokens || 0) / USAGE_BUDGET) * 100),
    lastUpdated: usage.lastUpdated || null,
  };
}

module.exports = { chat, getUsageSummary };
