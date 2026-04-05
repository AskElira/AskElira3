const fs = require('fs');
const path = require('path');

const DESIGN_INTENT = fs.readFileSync(path.join(__dirname, 'DESIGN_INTENT.md'), 'utf8');

function section(heading) {
  const regex = new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`);
  const match = DESIGN_INTENT.match(regex);
  return match ? match[0].trim() : '';
}

/**
 * Returns a scoped excerpt of DESIGN_INTENT.md appropriate for each agent.
 *
 * full     — Elira planning: needs everything to decompose UI floors correctly
 * build    — David: tokens, typography, spatial rules, anti-patterns
 * validate — Vex Gate 2: anti-patterns only (compact, decision-focused)
 * research — Alba: philosophy + color semantics to guide search direction
 */
function getDesignContext(scope = 'full') {
  switch (scope) {
    case 'full':
      return `## Design Intent\n\n${DESIGN_INTENT}`;
    case 'build':
      return [
        '## Design Intent (Build Constraints)',
        section('Color Semantics'),
        section('Typography Rules'),
        section('Spatial Rules'),
        section('Anti-Patterns'),
      ].join('\n\n');
    case 'validate':
      return `## Design Intent (Validation Rules)\n\n${section('Anti-Patterns')}`;
    case 'research':
      return [
        '## Design Intent (Research Guidance)',
        section('Philosophy'),
        section('Color Semantics'),
      ].join('\n\n');
    default:
      return '';
  }
}

module.exports = { getDesignContext, DESIGN_INTENT };
