# AskElira Design Intent

## Philosophy

AskElira is a control room for autonomous builders — not a dashboard, not a SaaS product page.

The UI communicates three things:
- **Confidence**: the system acts. It does not wait for the user to figure things out.
- **Precision**: every element has a specific role. Nothing is decorative.
- **Warmth**: this is a tool built by builders, for builders — not a corporate data center.

The visual language is warm dark. Sand and ember neutrals, not cold slate grays. When something happens, the right color fires — not randomly, but because each agent color carries semantic meaning. The user learns to read the screen like a cockpit: gold means Elira is deciding, red means Steven is fixing, green means a floor passed.

## Color Semantics

**--accent (#ffc53d) — Elira's Gold**
Signals decisions, architecture, and action points.
- USE FOR: interactive elements (buttons, active tabs, focused inputs), current status indicators, approval badges, key metric values the user should act on
- NEVER USE FOR: decorative backgrounds, icon tints, passive/informational text, hover fills that don't change state
- WHY: gold is scarce by design. When it appears, the user must pay attention. If gold is everywhere, it means nothing.

**--accent-hover (#ffd60a) — Brighter Gold**
- USE FOR: hover state of --accent elements only
- WHY: confirms interactivity without introducing a new color

**--accent-glow (rgba(255, 197, 61, 0.12)) — Ambient Gold**
- USE FOR: subtle background tint on active/selected containers (e.g., selected goal card)
- WHY: communicates "this is the thing in focus" without hard borders

**--steven (#e54d2e) — Steven's Red**
Means something needs human attention or a fix is in progress.
- USE FOR: error states, floor failure indicators, fix-in-progress badges, rejection labels
- NEVER USE FOR: warnings, deprecation notices, or secondary informational text
- WHY: red in this system is binary — it means "broken/emergency." Diluting it with warnings destroys the signal.

**--green (#30a46c) — Pass / Success**
- USE FOR: floor passed, goal complete, validation success
- NEVER USE FOR: general "positive" UI (e.g., pricing plan highlights, marketing callouts)

**--yellow (#ffd60a) — Warning / Pending**
- USE FOR: in-progress states, pending review, non-critical warnings
- NOT the same as --accent-hover (--yellow is a status color, --accent-hover is an interaction color)

**--blue (#4ccce6) — Informational / Links**
- USE FOR: external links, informational callouts, neutral metadata
- WHY: blue is the only cool color in the palette — it signals "external/reference" vs. the warm system colors

**--bronze (#d4a574) — Muted Warm Accent**
- USE FOR: secondary highlights, supporting metadata that needs visual weight without gold prominence

**--bg (#111110) / --surface (#191918) / --panel (#222221) — 3-Layer Elevation**
Warm dark — not cold tech gray. These three values represent three levels of depth.
- --bg: the page background. Nothing sits on it directly — it's the well.
- --surface: secondary areas (sidebar, header). One step up from the background.
- --panel: cards, modals, dropdowns. The "foreground" layer.
- USE the elevation model to show hierarchy — not borders alone.
- WHY: warm browns/charcoals signal a human-scale tool. Cold grays (#1a1a1a, #222, #333) signal a data center.

**--panel-hover (#2a2a28) — Hover Elevation**
- USE FOR: hover state of --panel elements (cards, list items)
- Just slightly lighter than --panel — confirms interactivity without jarring contrast

**--border (#3b3a37) / --border-strong (#494844)**
- --border: default structural borders (separators, card edges, input outlines)
- --border-strong: active, focused, or emphasized elements
- NEVER: use heavy borders (2px+) or drop shadows — they fight the warm dark background

**--text (#eeeeec) — Primary Text**
- USE FOR: headings, primary labels, content the user must read first
- NOT for: supporting copy, metadata, inactive states

**--text-dim (#b5b3ad) — Secondary Text**
- USE FOR: timestamps, secondary labels, supporting copy, inactive states, placeholders
- WHY: --text-dim tells the user "you don't need to read this right now." It is the most-used text color.
- NEVER USE --text-dim for: anything the user needs to act on

**--accent-text (#16120c) — Text on Gold**
- USE FOR: text rendered on a --accent background (buttons, badges)
- WHY: ensures legibility against the gold — dark enough to pass contrast, warm enough to not feel harsh

## Typography Rules

**--font: 'Inter', sans-serif**
- USE FOR: all human-readable prose, UI labels, navigation, messages, descriptions
- Inter is neutral and modern — it gets out of the way

**--mono: 'JetBrains Mono', monospace**
- USE FOR: code, terminal output, file names, numeric values, tokens, IDs, anything the user might copy/paste
- WHY: mono signals "machine-readable / exact." When a value is in mono, the user knows it is precise and copyable.
- RULE: anything numerical or code-like should use --mono. A floor ID, a token count, a file path, a version number — mono.

**Anti-pattern: mixing fonts in the same UI block**
- Do not use Inter and JetBrains Mono in the same sentence unless one is clearly prose and one is clearly data.

## Layout Density

- **Sidebar (280px)**: navigation layer — goals list, user model panel. Compact, always visible. Information density is appropriate because users scan, not read.
- **Main area**: workspace layer. Breathing room. The user is reading and acting here, not scanning.
- **Status readability**: agent color indicator + short status string = everything the user needs to scan. A floor card should be readable in under 1 second.
- **Error states need space**: when something fails, increase whitespace. Urgency is communicated by Steven's red, not by crowding more text in. An error state that is dense and cluttered communicates panic, not confidence.

## Spatial Rules

- Apply the 3-layer elevation model (bg → surface → panel) to communicate depth. Do not use all three layers in one component — pick the right level.
- Card borders (--border) communicate structure. --border-strong communicates focus or activity.
- Do not add drop shadows. The dark background makes shadows invisible and borders are sufficient.
- Padding inside cards: 16-24px. Tight padding (8px) is for compact list rows only.
- Do not nest cards inside cards — use elevation levels instead.

## Motion

- Transitions: 150ms ease for state changes (color, opacity, border). 200-300ms ease for panel open/close.
- No decorative motion. Animation confirms state change, not decorates the UI.
- Agent status spinners must match agent color: gold for Elira, red for Steven.
- Do not animate background colors on hover — only animate border or opacity.

## Anti-Patterns (Violations of Design Intent)

These are hard violations. If produced output contains any of these, it is wrong and must be fixed:

1. **Hardcoded hex colors** — always use `var(--accent)`, `var(--text-dim)`, `var(--panel)`, etc. Never `#ffc53d`, `#111110`, `#eeeeec`.
2. **Using --accent decoratively** — background fills, icon tints, decorative underlines. Gold loses its signal when it is everywhere.
3. **Using --red/--steven for warnings** — this color means "broken/emergency." Use --yellow for non-critical warnings.
4. **High-density layout for error states** — errors need space and clarity, not more information.
5. **Using --text for secondary/supporting copy** — use --text-dim. Full --text brightness is reserved for primary content.
6. **Cold grays** (#888, #999, #aaa, #ccc, #333, #222) instead of warm sand neutrals. These break the warmth identity.
7. **Sans-serif for data values** — use --mono for anything numerical, code-like, or copyable.
8. **Heavy borders or drop shadows** — 1px --border is sufficient. Drop shadows fight the background.
9. **Nesting cards inside cards** — use elevation levels. A --panel inside a --panel is visual noise.
10. **Using bright status colors (green/red/yellow) for non-status UI** — status colors are reserved for pipeline/agent state.

## Agent-Specific Application

**David (builder)**
Apply these rules to every frontend file produced. CSS must use CSS variables, not hex. Structure HTML to reflect the 3-layer elevation model. Typography: Inter for labels/prose, JetBrains Mono for data/code. When building status UIs, use agent colors semantically. The design intent context is a hard constraint — not a suggestion.

**Vex (validator)**
Flag any of the 10 anti-patterns above as design intent violations in Gate 2. Score a -5 to -15 point penalty per violation depending on severity. A file with 3+ hardcoded hex colors should not pass Gate 2 regardless of functional correctness.

**Elira (planner)**
When a floor has a frontend/UI deliverable, the successCondition must explicitly include design intent alignment (e.g., "Uses CSS variables for all colors, JetBrains Mono for data values, respects 3-layer elevation model"). Do not approve floors that only check functional correctness for UI work.

**Alba (researcher)**
When researching UI/frontend patterns, prefer dark-mode-first examples. Avoid Material Design, Bootstrap defaults, or Tailwind utility-class examples that use cold grays and bright primaries — they will require rework to align with the warm sand/ember identity. Look for: CSS custom properties usage, design token patterns, warm dark UI examples.

**Steven (fixer)**
When patching frontend files, preserve CSS variable usage. A patch that replaces `var(--accent)` with `#ffc53d` is wrong even if it "fixes" a visual bug. Fix the root cause — do not hardcode.
