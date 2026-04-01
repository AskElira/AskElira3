/**
 * Durable memory store — SQLite-backed replacement for in-memory/JSON user model.
 * Uses the existing better-sqlite3 DB from src/db.js.
 *
 * Schema: memories(id, key, value JSON, updated_at)
 * Keys: user_profile, session_history, build_patterns, suggestions, self_improvement_suggestions, lastDigestDate
 *
 * Exports: remember(key, value), recall(key), recallAll(), forgetOlderThan(days), migrate()
 */

const { db } = require('./db');
const fs = require('fs');
const path = require('path');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── Core API ────────────────────────────────────────────────────────────────

/**
 * Store a value under a key. Upserts (creates or replaces).
 * @param {string} key
 * @param {*} value - any JSON-serializable value
 */
function remember(key, value) {
  const json = JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO memories (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, json, now);
}

/**
 * Retrieve a value by key. Returns parsed JSON or null if not found.
 * @param {string} key
 * @returns {*|null}
 */
function recall(key) {
  const row = db.prepare('SELECT value FROM memories WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Retrieve all memories as { key: value } object.
 * @returns {Object}
 */
function recallAll() {
  const rows = db.prepare('SELECT key, value FROM memories ORDER BY updated_at DESC').all();
  const result = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Delete memories older than N days.
 * @param {number} days
 * @returns {number} rows deleted
 */
function forgetOlderThan(days) {
  const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
  const info = db.prepare('DELETE FROM memories WHERE updated_at < ?').run(cutoff);
  return info.changes;
}

// ── Migration: import existing user-model.json ──────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MODEL_PATH = path.join(PROJECT_ROOT, 'data', 'user-model.json');

/**
 * Migrate data/user-model.json into the memories table (one-time).
 * Safe to call multiple times — only migrates if user_profile key is empty AND file exists.
 */
function migrate() {
  const existing = recall('user_profile');
  if (existing) return; // already migrated

  try {
    if (fs.existsSync(MODEL_PATH)) {
      const data = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
      remember('user_profile', data);
      console.log('[Memory] Migrated user-model.json into SQLite');
    }
  } catch (err) {
    console.error('[Memory] Migration failed:', err.message);
  }
}

module.exports = { remember, recall, recallAll, forgetOlderThan, migrate };
