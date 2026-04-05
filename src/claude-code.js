/**
 * Claude Code integration for AskElira 3.
 *
 * Allows Hermes to delegate complex tasks to Claude Code CLI.
 * Claude Code has filesystem access, can run commands, and produces
 * higher quality code than the primary LLM.
 *
 * Usage:
 *   const { claudeCode } = require('./claude-code');
 *   const result = await claudeCode('Build a REST API in server.js', { cwd: workspacePath });
 */

const { execFile } = require('child_process');
const path = require('path');

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 min default
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

/**
 * Run a prompt through Claude Code CLI.
 * @param {string} prompt - The task for Claude Code
 * @param {Object} opts
 * @param {string} [opts.cwd] - Working directory (e.g., goal workspace)
 * @param {number} [opts.timeoutMs] - Timeout in ms (default 5 min)
 * @param {string} [opts.model] - Model override (default: claude's default)
 * @returns {Promise<{success: boolean, output: string, error: string, durationMs: number}>}
 */
function claudeCode(prompt, { cwd, timeoutMs, model } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();

    if (!ANTHROPIC_KEY) {
      return resolve({
        success: false,
        output: '',
        error: 'ANTHROPIC_API_KEY not set — Claude Code requires it',
        durationMs: 0,
      });
    }

    const args = ['-p', '--output-format', 'text'];
    if (model) args.push('--model', model);

    const child = execFile(CLAUDE_PATH, args, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs || CLAUDE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      },
    }, (err, stdout, stderr) => {
      const durationMs = Date.now() - start;
      if (err) {
        console.error(`[ClaudeCode] Error (${durationMs}ms):`, err.message);
        resolve({
          success: false,
          output: stdout?.trim() || '',
          error: stderr?.trim() || err.message,
          durationMs,
        });
      } else {
        console.log(`[ClaudeCode] Done (${durationMs}ms): ${(stdout || '').substring(0, 100)}...`);
        resolve({
          success: true,
          output: stdout?.trim() || '',
          error: stderr?.trim() || '',
          durationMs,
        });
      }
    });

    // Send prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Check if Claude Code is available.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  if (!ANTHROPIC_KEY) return false;
  try {
    const result = await claudeCode('respond with just the word "ok"', { timeoutMs: 15000 });
    return result.success;
  } catch (_) {
    return false;
  }
}

module.exports = { claudeCode, isAvailable };
