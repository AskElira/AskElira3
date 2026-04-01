const fs = require('fs');
const path = require('path');

const { execSync, execFileSync } = require('child_process');

const WORKSPACES_DIR = path.join(process.cwd(), 'workspaces');

function assertSafePath(goalId, resolvedPath) {
  const root = path.resolve(WORKSPACES_DIR, goalId);
  if (!resolvedPath.startsWith(root + path.sep) && resolvedPath !== root) {
    throw new Error(`Path traversal blocked: ${resolvedPath}`);
  }
}

function ensureGoalDir(goalId) {
  const dir = path.join(WORKSPACES_DIR, goalId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email "elira@askelira3.local"', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name "Elira"', { cwd: dir, stdio: 'ignore' });
    } catch (_) {}
  }
  return dir;
}

function writeFile(goalId, filename, content) {
  const dir = ensureGoalDir(goalId);
  const filePath = path.resolve(dir, filename);
  assertSafePath(goalId, filePath);
  const fileDir = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    execSync('git add -A', { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', `floor patch: ${filename}`], { cwd: dir, stdio: 'ignore' });
  } catch (_) {}
  return filePath;
}

function readFile(goalId, filename) {
  const filePath = path.resolve(WORKSPACES_DIR, goalId, filename);
  assertSafePath(goalId, filePath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const SKIP_EXTS = new Set(['.pyc', '.pyo', '.egg-info', '.lock', '.map', '.min.js']);

function listFiles(goalId) {
  const dir = path.join(WORKSPACES_DIR, goalId);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  function walk(currentDir, prefix) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), rel);
      } else {
        const ext = path.extname(entry.name);
        if (!SKIP_EXTS.has(ext)) results.push(rel);
      }
    }
  }
  walk(dir, '');
  return results;
}

function getWorkspacePath(goalId) {
  return path.join(WORKSPACES_DIR, goalId);
}

function readAllFiles(goalId) {
  const files = listFiles(goalId);
  const map = {};
  for (const f of files) {
    map[f] = readFile(goalId, f);
  }
  return map;
}

function getWorkspaceSummary(goalId, { maxChars = 2000, linesPerFile = 20 } = {}) {
  const files = listFiles(goalId);
  if (files.length === 0) return 'Workspace is empty.';
  const parts = [`Files (${files.length}): ${files.join(', ')}\n`];
  let total = parts[0].length;
  for (const f of files) {
    if (total >= maxChars) { parts.push('... (more files truncated)'); break; }
    const content = readFile(goalId, f);
    if (!content) continue;
    const lines = content.split('\n');
    const preview = lines.slice(0, linesPerFile).join('\n');
    const snippet = `\n--- ${f} ---\n${preview}${lines.length > linesPerFile ? '\n...' : ''}\n`;
    if (total + snippet.length > maxChars) {
      parts.push(`\n--- ${f} --- (truncated, ${lines.length} lines)\n`);
      break;
    }
    parts.push(snippet);
    total += snippet.length;
  }
  return parts.join('');
}

// Ensure the root workspaces directory exists on load
if (!fs.existsSync(WORKSPACES_DIR)) {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function rollbackWorkspace(goalId) {
  const dir = path.join(WORKSPACES_DIR, goalId);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`No git repo in workspace for goal ${goalId}`);
  execSync('git checkout HEAD~1 -- .', { cwd: dir });
  return true;
}

module.exports = { ensureGoalDir, writeFile, readFile, listFiles, getWorkspacePath, readAllFiles, getWorkspaceSummary, rollbackWorkspace };
