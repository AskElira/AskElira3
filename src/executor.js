/**
 * Executor — lets Hermes (Elira & Steven) run shell commands on behalf of the user.
 * Handles pip3 install, npm install, python3, node, bash, etc.
 * Always runs from the goal's workspace directory.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ALLOWED_COMMANDS = ['pip3', 'pip', 'npm', 'npx', 'node', 'python3', 'python', 'which', 'ls'];
const TIMEOUT_MS = 120000; // 2 minutes

/**
 * Run a shell command in the given working directory.
 * Returns { success, stdout, stderr, command, duration }
 */
function run(command, { cwd = process.cwd(), timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const parts = command.trim().split(/\s+/);
    const base = parts[0];
    const args = parts.slice(1);

    if (!ALLOWED_COMMANDS.includes(base)) {
      return resolve({ success: false, stdout: '', stderr: `Command not allowed: ${base}`, command, duration: 0, exitCode: 1 });
    }

    console.log(`[Executor] Running: ${command} (cwd: ${cwd})`);

    execFile(base, args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      const duration = Date.now() - start;
      const stderrStr = stderr?.trim() || '';
      const hardFail = err && err.code !== 0 && (
        stderrStr.includes('ERROR:') ||
        stderrStr.includes('error:') ||
        stderrStr.includes('command not found') ||
        stderrStr.includes('No module named') ||
        (!stdout && !stderrStr)
      );
      resolve({
        success: !hardFail,
        stdout: stdout?.trim() || '',
        stderr: stderrStr,
        command,
        duration,
        exitCode: err?.code || 0,
      });
    });
  });
}

/**
 * Auto-detect and install dependencies from workspace files.
 * Checks for requirements.txt, package.json, Pipfile etc.
 * Returns array of { command, result } objects.
 */
async function autoInstall(workspacePath) {
  const results = [];

  if (!fs.existsSync(workspacePath)) return results;

  const files = fs.readdirSync(workspacePath);

  // Python: requirements.txt
  if (files.includes('requirements.txt')) {
    console.log('[Executor] Found requirements.txt — running pip3 install');
    const result = await run(`pip3 install -r requirements.txt`, { cwd: workspacePath });
    results.push({ command: 'pip3 install -r requirements.txt', result });
    if (!result.success) {
      // Try pip as fallback
      const fallback = await run(`pip install -r requirements.txt`, { cwd: workspacePath });
      results.push({ command: 'pip install -r requirements.txt (fallback)', result: fallback });
    }
  }

  // Node.js: package.json (only if node_modules doesn't exist)
  if (files.includes('package.json') && !files.includes('node_modules')) {
    console.log('[Executor] Found package.json — running npm install');
    const result = await run(`npm install`, { cwd: workspacePath });
    results.push({ command: 'npm install', result });
  }

  return results;
}

/**
 * Run a list of commands from Hermes/Steven's fix plan.
 * Commands is an array of strings like ["pip3 install requests", "python3 main.py"]
 * Returns array of results.
 */
async function runCommands(commands, workspacePath) {
  const results = [];
  for (const cmd of commands) {
    const result = await run(cmd.trim(), { cwd: workspacePath });
    results.push({ command: cmd, result });
    if (!result.success) {
      console.error(`[Executor] Command failed: ${cmd}\n  stderr: ${result.stderr.substring(0, 200)}`);
    }
  }
  return results;
}

/**
 * Parse commands from Hermes output — looks for shell commands in the response.
 * Hermes may return commands in a JSON array or code block.
 */
function parseCommands(hermesOutput) {
  // Try JSON array first
  try {
    const match = hermesOutput.match(/\[[\s\S]*?\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.every(x => typeof x === 'string')) return arr;
    }
  } catch (_) { /* fall through */ }

  // Extract lines that look like shell commands
  const lines = hermesOutput.split('\n');
  return lines
    .map(l => l.replace(/^[$>]\s*/, '').trim())
    .filter(l => ALLOWED_COMMANDS.some(cmd => l.startsWith(cmd)));
}

/**
 * Format executor results as a readable summary string for logging.
 */
function summarizeResults(results) {
  return results.map(({ command, result }) =>
    `$ ${command}\n  → ${result.success ? 'OK' : 'FAILED'} (${result.duration}ms)${result.stderr ? '\n  stderr: ' + result.stderr.substring(0, 150) : ''}`
  ).join('\n');
}

/**
 * Run a command using execFile directly with pre-split args.
 * Unlike run(), this handles filenames with spaces correctly
 * because args are passed as an array, not split on whitespace.
 */
function runExecFile(cmd, args, { cwd = process.cwd(), timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const command = `${cmd} ${args.join(' ')}`;

    if (!ALLOWED_COMMANDS.includes(cmd)) {
      return resolve({ success: false, stdout: '', stderr: `Command not allowed: ${cmd}`, command, duration: 0, exitCode: 1 });
    }

    console.log(`[Executor] Running: ${command} (cwd: ${cwd})`);

    execFile(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      const duration = Date.now() - start;
      const stderrStr = stderr?.trim() || '';
      const hardFail = err && err.code !== 0 && (
        stderrStr.includes('ERROR:') ||
        stderrStr.includes('error:') ||
        stderrStr.includes('command not found') ||
        stderrStr.includes('No module named') ||
        (!stdout && !stderrStr)
      );
      resolve({
        success: !hardFail,
        stdout: stdout?.trim() || '',
        stderr: stderrStr,
        command,
        duration,
        exitCode: err?.code || 0,
      });
    });
  });
}

module.exports = { run, runExecFile, autoInstall, runCommands, parseCommands, summarizeResults };
