/**
 * Cross-goal memory via SQLite FTS5.
 * After each floor completes, its summary is indexed.
 * Alba queries this at research time to inject prior successful work.
 */
const { db } = require('./db');

// ── Schema ─────────────────────────────────────────────────────────────────

// Deduplication index (regular table, fast PRIMARY KEY lookup)
db.exec(`
  CREATE TABLE IF NOT EXISTS floor_memory_ids (
    floor_id TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// FTS5 virtual table — all text columns are full-text indexed except UNINDEXED ones
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS floor_memories USING fts5(
    goal_id    UNINDEXED,
    floor_id   UNINDEXED,
    goal_text,
    floor_name,
    floor_description,
    deliverable,
    summary,
    tags,
    created_at UNINDEXED
  );
`);

// ── Query sanitizer ─────────────────────────────────────────────────────────

/**
 * Strip FTS5 special chars so user input never causes a parse error.
 * Keeps only word characters and spaces. Limits to 15 terms.
 */
function sanitizeFtsQuery(query) {
  return (query || '')
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 15)
    .join(' ');
}

// ── Tag extraction ──────────────────────────────────────────────────────────

const TECH_KEYWORDS = [
  'node', 'python', 'express', 'fastapi', 'react', 'vue', 'svelte',
  'api', 'rest', 'graphql', 'grpc', 'telegram', 'bot', 'cli', 'data',
  'pipeline', 'etl', 'webhook', 'html', 'css', 'javascript', 'typescript',
  'sqlite', 'postgres', 'mysql', 'redis', 'docker', 'aws', 'vapi', 'voice',
  'dashboard', 'scraper', 'crawler', 'auth', 'jwt', 'oauth', 'stripe',
];

function extractTags(text) {
  const lower = (text || '').toLowerCase();
  return TECH_KEYWORDS.filter(k => lower.includes(k)).join(' ');
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Store a completed floor in the FTS memory.
 * No-ops if this floor has already been stored (dedup via floor_memory_ids).
 *
 * @returns {boolean} true if stored, false if already existed
 */
function storeFloorMemory({ goalId, floorId, goalText, floorName, floorDescription, deliverable, summary }) {
  try {
    const existing = db.prepare('SELECT 1 FROM floor_memory_ids WHERE floor_id = ?').get(floorId);
    if (existing) return false;

    const tags = extractTags(`${goalText} ${floorDescription} ${deliverable} ${summary}`);

    const store = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO floor_memory_ids (floor_id) VALUES (?)').run(floorId);
      db.prepare(`
        INSERT INTO floor_memories
          (goal_id, floor_id, goal_text, floor_name, floor_description, deliverable, summary, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        goalId || '',
        floorId || '',
        goalText || '',
        floorName || '',
        floorDescription || '',
        deliverable || '',
        summary || '',
        tags,
        Math.floor(Date.now() / 1000),
      );
    });
    store();
    return true;
  } catch (err) {
    console.error('[Memory] storeFloorMemory error:', err.message);
    return false;
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Full-text search across all stored floor memories.
 * Returns up to `limit` matches ordered by FTS5 relevance rank.
 *
 * @param {string} query - natural language query
 * @param {number} [limit=3]
 * @returns {Array}
 */
function searchMemory(query, limit = 3) {
  try {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    return db.prepare(`
      SELECT goal_id, floor_id, goal_text, floor_name, floor_description, deliverable, summary, tags, created_at
      FROM floor_memories
      WHERE floor_memories MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safe, limit);
  } catch (_) {
    return [];
  }
}

/**
 * List all stored memories, most recent first.
 */
function listMemories(limit = 50, offset = 0) {
  try {
    return db.prepare(`
      SELECT goal_id, floor_id, goal_text, floor_name, floor_description, deliverable, summary, tags, created_at
      FROM floor_memories
      ORDER BY rowid DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  } catch (_) {
    return [];
  }
}

/**
 * Count of indexed floor memories.
 */
function countMemories() {
  try {
    return db.prepare('SELECT COUNT(*) as count FROM floor_memory_ids').get().count;
  } catch (_) {
    return 0;
  }
}

module.exports = { storeFloorMemory, searchMemory, listMemories, countMemories };
