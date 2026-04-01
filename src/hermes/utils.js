/**
 * Shared utilities for all AskElira agents.
 * Imported by hermes/index.js, agents/alba.js, agents/david.js, agents/vex.js
 */

/**
 * Wrap user/agent input in XML delimiters to prevent prompt injection.
 * Strips null bytes and control characters, truncates to maxLen.
 */
function wrapInput(str, maxLen = 4000) {
  if (!str) return '';
  const clean = String(str)
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, maxLen);
  return `<user_input>${clean}</user_input>`;
}

module.exports = { wrapInput };
