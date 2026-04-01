const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./config');

const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema — base tables
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    status TEXT DEFAULT 'planning',
    building_plan TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS floors (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    floor_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    success_condition TEXT,
    deliverable TEXT,
    status TEXT DEFAULT 'pending',
    research TEXT,
    result TEXT,
    iteration INTEGER DEFAULT 0,
    vex1_score INTEGER,
    vex2_score INTEGER,
    fix_patches TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (goal_id) REFERENCES goals(id)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT,
    floor_id TEXT,
    agent TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT, floor_id TEXT, agent TEXT, model TEXT,
    tokens_in INTEGER, tokens_out INTEGER, total_tokens INTEGER,
    duration_ms INTEGER, created_at INTEGER DEFAULT (unixepoch())
  );
`);

// Migration: add columns to existing tables if they are missing
function safeAddColumn(table, column, type, defaultVal) {
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = info.some(c => c.name === column);
    if (!exists) {
      const defClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defClause}`);
    }
  } catch (e) {
    // Column likely already exists
  }
}

const ALLOWED_GOAL_FIELDS = new Set(['text','status','building_plan','llm_calls','tokens_est']);
const ALLOWED_FLOOR_FIELDS = new Set(['status','research','result','iteration','vex1_score','vex2_score','fix_patches','current_step','depends_on']);

safeAddColumn('floors', 'success_condition', 'TEXT', "''");
safeAddColumn('floors', 'deliverable', 'TEXT', "''");
safeAddColumn('floors', 'vex1_score', 'INTEGER', 'NULL');
safeAddColumn('floors', 'vex2_score', 'INTEGER', 'NULL');
safeAddColumn('floors', 'fix_patches', 'TEXT', 'NULL');
safeAddColumn('goals', 'llm_calls', 'INTEGER', '0');
safeAddColumn('goals', 'tokens_est', 'INTEGER', '0');
safeAddColumn('floors', 'current_step', 'TEXT', "''");
safeAddColumn('floors', 'depends_on', 'TEXT', "'[]'");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_floors_goal_id ON floors(goal_id);
  CREATE INDEX IF NOT EXISTS idx_floors_status ON floors(status);
  CREATE INDEX IF NOT EXISTS idx_logs_goal_id ON logs(goal_id);
  CREATE INDEX IF NOT EXISTS idx_logs_floor_id ON logs(floor_id);
`);

// ── Goals ──

function createGoal(text) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO goals (id, text) VALUES (?, ?)').run(id, text);
  return getGoal(id);
}

function getGoal(id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

function updateGoal(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_GOAL_FIELDS.has(k)) throw new Error(`Invalid goal field: ${k}`);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return getGoal(id);
  vals.push(id);
  db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getGoal(id);
}

function listGoals() {
  return db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all();
}

// ── Floors ──

function createFloor(goalId, floorNumber, name, description, successCondition, deliverable, dependsOn = []) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO floors (id, goal_id, floor_number, name, description, success_condition, deliverable, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, goalId, floorNumber, name, description || '', successCondition || '', deliverable || '', JSON.stringify(dependsOn));
  return getFloor(id);
}

function getFloor(id) {
  return db.prepare('SELECT * FROM floors WHERE id = ?').get(id);
}

function updateFloor(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FLOOR_FIELDS.has(k)) throw new Error(`Invalid floor field: ${k}`);
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return getFloor(id);
  vals.push(id);
  db.prepare(`UPDATE floors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getFloor(id);
}

function listFloors(goalId) {
  return db.prepare(
    'SELECT * FROM floors WHERE goal_id = ? ORDER BY floor_number ASC'
  ).all(goalId);
}

function listLiveFloors() {
  return db.prepare("SELECT * FROM floors WHERE status = 'live'").all();
}

function listBlockedFloors() {
  return db.prepare("SELECT * FROM floors WHERE status = 'blocked'").all();
}

function updateFloorVex(id, gate, score) {
  const col = gate === 1 ? 'vex1_score' : 'vex2_score';
  if (col !== 'vex1_score' && col !== 'vex2_score') throw new Error('Invalid gate');
  db.prepare(`UPDATE floors SET ${col} = ? WHERE id = ?`).run(score, id);
  return getFloor(id);
}

function updateFloorPatches(id, patches) {
  const json = typeof patches === 'string' ? patches : JSON.stringify(patches);
  db.prepare('UPDATE floors SET fix_patches = ? WHERE id = ?').run(json, id);
  return getFloor(id);
}

// ── Logs ──

function addLog(goalId, floorId, agent, message) {
  db.prepare(
    'INSERT INTO logs (goal_id, floor_id, agent, message) VALUES (?, ?, ?, ?)'
  ).run(goalId, floorId || null, agent, message);
}

function getLogs(opts = {}) {
  const { goalId, floorId, agent, limit = 200 } = opts;
  if (floorId) {
    return db.prepare(
      'SELECT * FROM logs WHERE floor_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(floorId, limit);
  }
  if (goalId && agent) {
    return db.prepare(
      'SELECT * FROM logs WHERE goal_id = ? AND agent = ? ORDER BY created_at DESC LIMIT ?'
    ).all(goalId, agent, limit);
  }
  if (goalId) {
    return db.prepare(
      'SELECT * FROM logs WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(goalId, limit);
  }
  if (agent) {
    return db.prepare(
      'SELECT * FROM logs WHERE agent = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agent, limit);
  }
  return db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function logLlmCall({ goalId, floorId, agent, model, tokensIn, tokensOut, totalTokens, durationMs }) {
  db.prepare(
    `INSERT INTO llm_calls (goal_id, floor_id, agent, model, tokens_in, tokens_out, total_tokens, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(goalId||null, floorId||null, agent||null, model||null, tokensIn||0, tokensOut||0, totalTokens||0, durationMs||0);
}

function getLlmStats() {
  const byModel = db.prepare(
    `SELECT model, COUNT(*) as calls, SUM(total_tokens) as tokens,
            SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out,
            AVG(duration_ms) as avg_duration_ms
     FROM llm_calls GROUP BY model`
  ).all();
  const totals = db.prepare(
    `SELECT COUNT(*) as total_calls, SUM(total_tokens) as total_tokens FROM llm_calls`
  ).get();
  return { byModel, totals };
}

function incrementGoalLlmUsage(goalId, tokens) {
  db.prepare(`UPDATE goals SET llm_calls = llm_calls + 1, tokens_est = tokens_est + ? WHERE id = ?`).run(tokens||0, goalId);
}

module.exports = {
  db,
  createGoal, getGoal, updateGoal, listGoals,
  createFloor, getFloor, updateFloor, listFloors, listLiveFloors, listBlockedFloors,
  updateFloorVex, updateFloorPatches,
  addLog, getLogs,
  logLlmCall, getLlmStats, incrementGoalLlmUsage,
};
