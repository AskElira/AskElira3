/**
 * Credential memory — so Hermes never asks for the same token twice.
 *
 * Two sources of truth:
 *  1. Per-workspace .env files (authoritative for a specific build)
 *  2. Global credentials store (data/credentials.json) — what the user has
 *     ever shared with Hermes, keyed by service
 *
 * When Hermes/Claude Code is about to run, we build a "known credentials"
 * report that gets injected into the task context, so Claude Code knows
 * which credentials are already configured and never asks for them again.
 *
 * This module NEVER logs or prints raw credential values — only metadata
 * (which keys are set, when they were last used).
 */

const fs = require('fs');
const path = require('path');

const GLOBAL_STORE = path.resolve(__dirname, '..', 'data', 'credentials.json');

// Known credential patterns and what service they belong to
const SECRET_PATTERNS = [
  { name: 'MINIMAX_API_KEY',   service: 'minimax',   pattern: /\b(sk-cp-[a-zA-Z0-9_-]{20,})\b/ },
  { name: 'ANTHROPIC_API_KEY', service: 'anthropic', pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/ },
  { name: 'OPENAI_API_KEY',    service: 'openai',    pattern: /\b(sk-[a-zA-Z0-9]{40,})\b/ },
  { name: 'TELEGRAM_BOT_TOKEN',service: 'telegram',  pattern: /\b(\d{9,11}:AA[a-zA-Z0-9_-]{30,})\b/ },
  { name: 'AGENTMAIL_API_KEY', service: 'agentmail', pattern: /\b(am_us_[a-zA-Z0-9]{30,})\b/ },
  { name: 'GITHUB_TOKEN',      service: 'github',    pattern: /\b(ghp_[a-zA-Z0-9]{30,}|gho_[a-zA-Z0-9]{30,})\b/ },
  { name: 'NVIDIA_API_KEY',    service: 'nvidia',    pattern: /\b(nvapi-[a-zA-Z0-9_-]{30,})\b/ },
  { name: 'HUGGINGFACE_TOKEN', service: 'huggingface', pattern: /\b(hf_[a-zA-Z0-9]{30,})\b/ },
];

// ─── Global store (survives restarts) ───────────────────────────────────────

function loadGlobalStore() {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_STORE, 'utf8'));
  } catch (_) {
    return { credentials: {}, updatedAt: null };
  }
}

function saveGlobalStore(store) {
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(GLOBAL_STORE), { recursive: true });
  fs.writeFileSync(GLOBAL_STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Save a credential to the global store. Also auto-detects service from value.
 */
function saveCredential(keyName, value, meta = {}) {
  if (!value || typeof value !== 'string') return;
  const store = loadGlobalStore();
  store.credentials[keyName] = {
    value,
    service: detectService(value) || meta.service || 'unknown',
    updatedAt: new Date().toISOString(),
    source: meta.source || 'unknown',
  };
  saveGlobalStore(store);
}

function getCredential(keyName) {
  const store = loadGlobalStore();
  return store.credentials[keyName]?.value || null;
}

function listGlobalCredentials() {
  const store = loadGlobalStore();
  return Object.entries(store.credentials).map(([name, data]) => ({
    name,
    service: data.service,
    updatedAt: data.updatedAt,
    source: data.source,
    valuePreview: maskValue(data.value),
  }));
}

function detectService(value) {
  for (const p of SECRET_PATTERNS) {
    if (p.pattern.test(value)) return p.service;
  }
  return null;
}

function maskValue(v) {
  if (!v || v.length < 8) return '***';
  return v.substring(0, 7) + '...' + v.substring(v.length - 4);
}

// ─── Message scanner (extract credentials from user text) ───────────────────

/**
 * Scan a user message for any credential patterns and return what was found.
 * Returns [{ name, service, value }] — caller decides whether to save/use.
 */
function scanMessage(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  for (const p of SECRET_PATTERNS) {
    const match = text.match(p.pattern);
    if (match) {
      found.push({ name: p.name, service: p.service, value: match[1] });
    }
  }
  return found;
}

/**
 * Extract and auto-save any credentials from a message.
 * Returns the list that was saved.
 */
function captureFromMessage(text, source = 'chat') {
  const found = scanMessage(text);
  for (const cred of found) {
    saveCredential(cred.name, cred.value, { service: cred.service, source });
  }
  return found;
}

// ─── Workspace .env scanner ─────────────────────────────────────────────────

/**
 * Parse a .env file and return key → value map.
 */
function parseEnvFile(envPath) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    const result = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.substring(0, eq).trim();
      let value = trimmed.substring(eq + 1).trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) result[key] = value;
    }
    return result;
  } catch (_) {
    return {};
  }
}

/**
 * Scan a workspace directory for .env files and return all credentials found.
 * Returns: { envFiles: [paths], credentials: { KEY: { value, source, detected } } }
 */
function scanWorkspace(workspacePath) {
  const result = { envFiles: [], credentials: {} };
  if (!workspacePath || !fs.existsSync(workspacePath)) return result;

  // Look for .env, .env.local, .env.production in root
  const candidates = ['.env', '.env.local', '.env.production', 'config.env'];
  for (const filename of candidates) {
    const envPath = path.join(workspacePath, filename);
    if (fs.existsSync(envPath)) {
      result.envFiles.push(filename);
      const parsed = parseEnvFile(envPath);
      for (const [key, value] of Object.entries(parsed)) {
        // Skip placeholder values
        if (/^(your_|placeholder|xxx|<.*>|TODO|changeme)/i.test(value) || value.length < 5) continue;
        result.credentials[key] = {
          value,
          source: filename,
          detected: detectService(value) || 'custom',
        };
      }
    }
  }
  return result;
}

// ─── Build Hermes context string ────────────────────────────────────────────

/**
 * Build a summary string of known credentials for a workspace.
 * Injects into Claude Code task context so it never asks for what's set.
 * Does NOT expose raw values in the summary — Claude Code has filesystem
 * access and can read the .env itself if it needs the actual value.
 */
function buildCredentialContext(workspacePath) {
  const workspace = scanWorkspace(workspacePath);
  const global = loadGlobalStore();

  const lines = [];

  if (workspace.envFiles.length > 0) {
    lines.push(`Workspace .env files present: ${workspace.envFiles.join(', ')}`);
  }

  const wsKeys = Object.keys(workspace.credentials);
  if (wsKeys.length > 0) {
    lines.push(`Credentials already set in workspace .env (do NOT ask the user for these; read them from .env if needed):`);
    for (const key of wsKeys) {
      const { source, detected } = workspace.credentials[key];
      lines.push(`  - ${key} (${detected}, in ${source})`);
    }
  }

  // Only include global credentials that aren't already in the workspace
  const globalKeys = Object.keys(global.credentials || {}).filter(k => !workspace.credentials[k]);
  if (globalKeys.length > 0) {
    lines.push(`\nKnown credentials from previous sessions (the user shared these before — if the task needs them, write them to the workspace .env, don't ask again):`);
    for (const key of globalKeys) {
      const { service, source } = global.credentials[key];
      lines.push(`  - ${key} (${service}, shared via ${source})`);
    }
  }

  if (lines.length === 0) return '';
  return '\n\n## KNOWN CREDENTIALS\n' + lines.join('\n');
}

/**
 * Get a specific global credential value (used for injecting into new workspaces).
 */
function getGlobalValue(keyName) {
  const store = loadGlobalStore();
  return store.credentials[keyName]?.value || null;
}

module.exports = {
  saveCredential,
  getCredential,
  listGlobalCredentials,
  scanMessage,
  captureFromMessage,
  scanWorkspace,
  parseEnvFile,
  buildCredentialContext,
  getGlobalValue,
  maskValue,
};
