const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { createBreaker, CircuitOpenError } = require('./circuit-breaker');

const ollamaBreaker = createBreaker('ollama', { cooldownMs: 120000 });

// Detect Ollama availability at startup — skip fallback entirely if not running
let ollamaAvailable = false;
fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
  .then(() => { ollamaAvailable = true; console.log('[LLM] Ollama detected — local fallback enabled'); })
  .catch(() => { console.log('[LLM] Ollama not available — local fallback disabled'); });

// ── Usage tracking ──────────────────────────────────────────────────────────
const USAGE_FILE = path.resolve(__dirname, '..', 'data', 'usage.json');
const USAGE_BUDGET = parseInt(process.env.TOKEN_BUDGET || '5000000', 10); // default 5M tokens
const USAGE_ALERT_THRESHOLD = 0.9;

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

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // max 1 alert per 6 hours

function trackUsage(tokensUsed) {
  const usage = loadUsage();
  usage.totalTokens += tokensUsed;
  usage.calls += 1;
  usage.lastUpdated = new Date().toISOString();

  const pct = usage.totalTokens / USAGE_BUDGET;
  const lastAlert = usage.lastAlertAt ? new Date(usage.lastAlertAt).getTime() : 0;
  const now = Date.now();

  if (pct >= USAGE_ALERT_THRESHOLD && (now - lastAlert) > ALERT_COOLDOWN_MS) {
    usage.lastAlertAt = new Date().toISOString();
    const used = Math.round(pct * 100);
    console.warn(`[LLM] Usage at ${used}% of budget (${usage.totalTokens.toLocaleString()} / ${USAGE_BUDGET.toLocaleString()} tokens)`);
    try {
      const { sendTelegram } = require('./notify');
      sendTelegram(`Usage at *${used}%* of budget (${usage.totalTokens.toLocaleString()} / ${USAGE_BUDGET.toLocaleString()} tokens). Raise TOKEN_BUDGET in .env to silence.`).catch(() => {});
    } catch {}
  }

  saveUsage(usage);
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

  const res = await fetchWithTimeout('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: allMessages,
      stream: false,
      options: { num_predict: maxTokens },
    }),
  }, OLLAMA_TIMEOUT_MS);
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
    .replace(/<minimax:tool_?call>[\s\S]*?<\/minimax:tool_?call>/gi, '')
    .replace(/```tool[\s\S]*?```/gi, '')
    // Strip other model-specific wrapper tags (e.g. <response>, <output>, <result>)
    .replace(/<\/?(?:response|output|result|reply|assistant)>/gi, '')
    .trim();
  // Unwrap <answer>...</answer> — some models wrap final output in this tag
  const answerMatch = out.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (answerMatch) out = answerMatch[1].trim();
  if (!out && text.length > 0) {
    console.warn(`[LLM] stripThinking produced empty output from ${text.length} chars. Raw: ${text.substring(0, 300)}`);
    // Last resort: strip only known model wrapper tags, preserve everything else
    out = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<minimax:[\w_]+>[\s\S]*?<\/minimax:[\w_]+>/gi, '')
      .replace(/<\/?(?:response|output|result|reply|assistant|invoke|parameter)>/gi, '')
      .trim();
  }
  return out;
}

// ── Timeout-protected fetch ─────────────────────────────────────────────────
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);  // 120s for cloud LLM (complex builds need more)
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10); // 30s for local

function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer))
    .catch(err => {
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
      }
      throw err;
    });
}

async function chat(messages, { model, system, maxTokens = 4096, isBuildingTask: building = false, goalId, floorId, agent } = {}) {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY not configured');
  }

  // Route to local Ollama when over 90% budget, unless it's a building task or Ollama isn't available
  if (!building && ollamaAvailable && isOverThreshold()) {
    try {
      console.log('[LLM] Over 90% budget — routing chat to local Ollama');
      return await ollamaBreaker.call(() => ollamaChat(messages, { system, maxTokens }));
    } catch (err) {
      if (err instanceof CircuitOpenError) console.warn('[LLM] Ollama circuit open — using cloud LLM');
      else console.warn('[LLM] Ollama fallback failed, using cloud LLM:', err.message);
    }
  }

  const resolvedModel = model || config.agentModel;

  const callProvider = () => {
    if (config.isAnthropic && !config.isOpenAI) {
      return anthropicChat(messages, { model: resolvedModel, system, maxTokens, goalId, floorId, agent });
    }
    return openaiChat(messages, { model: resolvedModel, system, maxTokens, goalId, floorId, agent });
  };

  const reply = await callProvider();

  // Retry once if reply is empty/whitespace (MiniMax sometimes returns only tool_call tags with no text)
  if (!reply || !reply.trim()) {
    console.warn(`[LLM] Empty reply from ${resolvedModel}, retrying with anti-tool-call hint...`);
    // Append a hint to the last user message to prevent tool-call-only responses
    const retryMessages = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: m.content + '\n\n[Respond with plain text only. Do not use tool calls or function calls.]' }
        : m
    );
    const retrySystem = system ? system + '\n\nIMPORTANT: Respond with plain text only. Do NOT output tool_call, invoke, or function_call tags.' : system;
    const retryFn = () => {
      if (config.isAnthropic && !config.isOpenAI) {
        return anthropicChat(retryMessages, { model: resolvedModel, system: retrySystem, maxTokens, goalId, floorId, agent });
      }
      return openaiChat(retryMessages, { model: resolvedModel, system: retrySystem, maxTokens, goalId, floorId, agent });
    };
    const retry = await retryFn();
    if (!retry) {
      console.warn(`[LLM] Empty reply on retry — returning fallback`);
      return '(No response generated. Please try again.)';
    }
    return retry;
  }

  return reply;
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

  const data = await withRetry(() => fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, LLM_TIMEOUT_MS).then(async r => {
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Anthropic API error ${r.status}: ${errText}`);
    }
    return r.json();
  }));
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

  const data = await withRetry(() => fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  }, LLM_TIMEOUT_MS).then(async r => {
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`OpenAI API error ${r.status}: ${errText}`);
    }
    return r.json();
  }));
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
