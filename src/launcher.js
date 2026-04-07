/**
 * Build Launcher — spawns completed builds on isolated ports so users can
 * actually see them work. Supports multiple concurrent launches.
 *
 * Flow:
 *   1. Detect entry point (npm start, node index.js, python main.py, etc.)
 *   2. Allocate a deterministic port from the goal ID hash
 *   3. Auto-install dependencies (npm install / pip install)
 *   4. Spawn the process with PORT env var injected
 *   5. Track the process in memory so it can be stopped later
 *   6. Capture stdout/stderr in a circular buffer
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workspace = require('./pipeline/workspace');

const PORT_RANGE_START = 4100;
const PORT_RANGE_END = 4999;
const MAX_LOG_LINES = 200;

// goalId → { pid, port, url, status, startedAt, cmd, logs, child, listeners }
const running = new Map();

/**
 * Deterministic port from goal ID — same goal always gets the same port.
 */
function portFromGoalId(goalId) {
  const hash = crypto.createHash('md5').update(goalId).digest();
  const n = hash.readUInt32BE(0);
  const range = PORT_RANGE_END - PORT_RANGE_START + 1;
  return PORT_RANGE_START + (n % range);
}

/**
 * Detect the entry point for a goal's workspace.
 * Returns { kind, cmd, args } or null if nothing found.
 */
function detectEntryPoint(wsPath) {
  // 1. package.json with start script or main
  const pkgJsonPath = path.join(wsPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { kind: 'npm', cmd: 'npm', args: ['start'] };
      }
      if (pkg.main && fs.existsSync(path.join(wsPath, pkg.main))) {
        return { kind: 'node', cmd: 'node', args: [pkg.main] };
      }
    } catch (_) {}
  }

  // 2. Common Node.js entry files in root
  for (const f of ['index.js', 'server.js', 'app.js', 'main.js']) {
    if (fs.existsSync(path.join(wsPath, f))) {
      return { kind: 'node', cmd: 'node', args: [f] };
    }
  }

  // 3. Python web apps — check for Flask/FastAPI patterns
  for (const f of ['server.py', 'app.py', 'main.py', 'run.py', 'wsgi.py']) {
    if (fs.existsSync(path.join(wsPath, f))) {
      const content = fs.readFileSync(path.join(wsPath, f), 'utf8');
      // FastAPI/uvicorn
      if (/from fastapi|FastAPI\(/i.test(content)) {
        const modName = f.replace('.py', '');
        return { kind: 'fastapi', cmd: 'python3', args: ['-m', 'uvicorn', `${modName}:app`, '--host', '127.0.0.1', '--port', '__PORT__'] };
      }
      // Flask
      if (/from flask|Flask\(/i.test(content)) {
        return { kind: 'flask', cmd: 'python3', args: [f] };
      }
      // Generic Python script
      return { kind: 'python', cmd: 'python3', args: [f] };
    }
  }

  // 4. Static HTML site
  if (fs.existsSync(path.join(wsPath, 'index.html'))) {
    return { kind: 'static', cmd: 'python3', args: ['-m', 'http.server', '__PORT__', '--bind', '127.0.0.1'] };
  }

  // 5. Makefile with run target
  const makefilePath = path.join(wsPath, 'Makefile');
  if (fs.existsSync(makefilePath)) {
    const makefile = fs.readFileSync(makefilePath, 'utf8');
    if (/^run:/m.test(makefile)) {
      return { kind: 'make', cmd: 'make', args: ['run'] };
    }
  }

  return null;
}

/**
 * Install dependencies for the workspace before launch.
 * Returns { ok, output, errors }
 */
async function installDependencies(wsPath) {
  return new Promise((resolve) => {
    const hasPackageJson = fs.existsSync(path.join(wsPath, 'package.json'));
    const hasRequirements = fs.existsSync(path.join(wsPath, 'requirements.txt'));
    const hasPyproject = fs.existsSync(path.join(wsPath, 'pyproject.toml'));

    if (!hasPackageJson && !hasRequirements && !hasPyproject) {
      return resolve({ ok: true, output: 'No dependency files detected', errors: '' });
    }

    const results = [];
    const runStep = (cmd, args, next) => {
      const child = spawn(cmd, args, { cwd: wsPath, timeout: 120000 });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('close', (code) => {
        results.push({ cmd: `${cmd} ${args.join(' ')}`, code, out: out.slice(-500), err: err.slice(-500) });
        if (next) next();
      });
      child.on('error', (e) => {
        results.push({ cmd: `${cmd} ${args.join(' ')}`, code: -1, out: '', err: e.message });
        if (next) next();
      });
    };

    const steps = [];
    if (hasPackageJson && !fs.existsSync(path.join(wsPath, 'node_modules'))) {
      steps.push(() => new Promise(r => runStep('npm', ['install', '--silent', '--no-audit', '--no-fund'], r)));
    }
    if (hasRequirements) {
      steps.push(() => new Promise(r => runStep('python3', ['-m', 'pip', 'install', '--user', '--quiet', '-r', 'requirements.txt'], r)));
    }

    if (steps.length === 0) {
      return resolve({ ok: true, output: 'Dependencies already installed', errors: '' });
    }

    (async () => {
      for (const step of steps) await step();
      const failed = results.filter(r => r.code !== 0);
      resolve({
        ok: failed.length === 0,
        output: results.map(r => `$ ${r.cmd}\n${r.out}`).join('\n'),
        errors: failed.map(r => `${r.cmd}: ${r.err}`).join('\n'),
      });
    })();
  });
}

/**
 * Launch a goal's build on its assigned port.
 * @param {string} goalId
 * @returns {Promise<{ok, port, url, pid, error?}>}
 */
async function launch(goalId) {
  // Already running? Return existing info.
  if (running.has(goalId)) {
    const existing = running.get(goalId);
    if (existing.status === 'running') {
      return { ok: true, port: existing.port, url: existing.url, pid: existing.pid, alreadyRunning: true };
    }
    // Dead entry — clean up
    running.delete(goalId);
  }

  const wsPath = workspace.getWorkspacePath(goalId);
  if (!fs.existsSync(wsPath)) {
    return { ok: false, error: 'Workspace not found' };
  }

  const entry = detectEntryPoint(wsPath);
  if (!entry) {
    return { ok: false, error: 'No entry point detected (no package.json, index.js, server.py, app.py, index.html, or Makefile)' };
  }

  // Allocate port
  const port = portFromGoalId(goalId);

  // Record placeholder state so concurrent launch calls see it
  const state = {
    pid: null,
    port,
    url: `http://localhost:${port}`,
    status: 'installing',
    startedAt: Date.now(),
    cmd: `${entry.cmd} ${entry.args.join(' ')}`,
    kind: entry.kind,
    logs: [],
    child: null,
    listeners: new Set(),
    entry,
    wsPath,
  };
  running.set(goalId, state);

  // Install dependencies first
  const install = await installDependencies(wsPath);
  if (!install.ok) {
    state.status = 'error';
    state.logs.push(`[install] FAILED: ${install.errors}`);
    return { ok: false, error: `Dependency install failed: ${install.errors.substring(0, 300)}`, port, url: state.url };
  }
  if (install.output) state.logs.push(`[install] ${install.output.substring(0, 500)}`);

  // Substitute __PORT__ in args
  const finalArgs = entry.args.map(a => a === '__PORT__' ? String(port) : a);

  // Spawn the process with PORT env var
  state.status = 'running';
  const child = spawn(entry.cmd, finalArgs, {
    cwd: wsPath,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    detached: false,
  });

  state.pid = child.pid;
  state.child = child;
  state.logs.push(`[spawn] ${entry.cmd} ${finalArgs.join(' ')} (PID ${child.pid}, PORT=${port})`);

  const pushLog = (line) => {
    state.logs.push(line);
    if (state.logs.length > MAX_LOG_LINES) {
      state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
    }
    // Notify SSE listeners
    for (const send of state.listeners) {
      try { send(line); } catch (_) {}
    }
  };

  child.stdout.on('data', (d) => {
    const text = d.toString().replace(/\n$/, '');
    for (const line of text.split('\n')) pushLog(line);
  });
  child.stderr.on('data', (d) => {
    const text = d.toString().replace(/\n$/, '');
    for (const line of text.split('\n')) pushLog(`[err] ${line}`);
  });
  child.on('close', (code) => {
    state.status = code === 0 ? 'stopped' : 'crashed';
    state.exitCode = code;
    pushLog(`[exit] code=${code}`);
    // Notify listeners of closure
    for (const send of state.listeners) {
      try { send('__CLOSED__'); } catch (_) {}
    }
  });
  child.on('error', (err) => {
    state.status = 'error';
    pushLog(`[error] ${err.message}`);
  });

  // Wait a moment to see if it crashes immediately
  await new Promise(r => setTimeout(r, 800));
  if (state.status !== 'running') {
    return { ok: false, error: `Process exited immediately (code ${state.exitCode}). Last logs: ${state.logs.slice(-5).join(' | ').substring(0, 400)}`, port, url: state.url };
  }

  return { ok: true, port, url: state.url, pid: state.pid, kind: entry.kind };
}

/**
 * Stop a running launched process.
 */
async function stop(goalId) {
  const state = running.get(goalId);
  if (!state || state.status !== 'running') {
    return { ok: false, error: 'Not running' };
  }
  try {
    state.child.kill('SIGTERM');
    // Give it 2s to shut down gracefully, then SIGKILL
    await new Promise(r => setTimeout(r, 2000));
    if (state.status === 'running') {
      try { state.child.kill('SIGKILL'); } catch (_) {}
    }
    state.status = 'stopped';
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get current launch status for a goal.
 */
function getStatus(goalId) {
  const state = running.get(goalId);
  if (!state) return { status: 'idle' };
  return {
    status: state.status,
    pid: state.pid,
    port: state.port,
    url: state.url,
    startedAt: state.startedAt,
    cmd: state.cmd,
    kind: state.kind,
    logs: state.logs.slice(-50),
    exitCode: state.exitCode,
  };
}

/**
 * List all currently tracked launches.
 */
function listRunning() {
  const out = [];
  for (const [goalId, state] of running.entries()) {
    out.push({
      goalId,
      status: state.status,
      port: state.port,
      url: state.url,
      pid: state.pid,
      kind: state.kind,
      startedAt: state.startedAt,
    });
  }
  return out;
}

/**
 * Subscribe to live log updates for a goal (for SSE streaming).
 * Returns an unsubscribe function.
 */
function subscribeLogs(goalId, sendFn) {
  const state = running.get(goalId);
  if (!state) return () => {};
  state.listeners.add(sendFn);
  // Replay recent logs
  for (const line of state.logs.slice(-20)) {
    try { sendFn(line); } catch (_) {}
  }
  return () => state.listeners.delete(sendFn);
}

/**
 * Kill all running launches on server shutdown.
 */
function cleanupAll() {
  for (const [goalId, state] of running.entries()) {
    if (state.status === 'running' && state.child) {
      try { state.child.kill('SIGTERM'); } catch (_) {}
    }
  }
  running.clear();
}

process.on('SIGTERM', cleanupAll);
process.on('SIGINT', cleanupAll);
process.on('exit', cleanupAll);

module.exports = {
  launch,
  stop,
  getStatus,
  listRunning,
  subscribeLogs,
  detectEntryPoint,
  portFromGoalId,
};
