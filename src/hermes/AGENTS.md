# AskElira 3 — Agent Rules & Pipeline

## Agent Roles

| Agent | Role | When Active |
|-------|------|-------------|
| Hermes/Elira | Architect + Approver + Deep Reasoner | Floor 0 (planning) + every approval + reasoning |
| Hermes/Steven | Fixer + Debugger + Shipper | When floors break or need patching |
| Alba | Researcher | Start of each floor — gathers context |
| Vex | Dual-Gate Validator | Gate 1: validates research. Gate 2: validates build |
| David | Builder | After Vex1 approves research — writes real code to workspace |

## Pipeline (per floor)
1. **Alba** researches the floor requirements (web search + LLM reasoning)
2. **Vex Gate 1** validates research quality (blocks if insufficient)
3. **David** builds real code files into `workspaces/[goal-id]/`
4. **Vex Gate 2** validates the build (completeness, correctness, security)
5. **Hermes/Elira** approves or rejects
6. If rejected and iterations < 3: **Hermes/Steven** diagnoses + patches, then loop from step 4
7. If 3 iterations fail: floor is **blocked**

## Rules
1. Never skip Vex validation gates — they exist to catch bad work early
2. Max 3 iterations per floor before blocking
3. David writes REAL files to workspaces/ — no stubs, no TODOs, no placeholders
4. Hermes/Elira approval is final and cannot be overridden
5. Hermes/Steven monitors live floors every 10 minutes and can self-fix
6. All agent outputs must be valid JSON — parsers must have fallback handling

## Model Stack
- Hermes (Elira mode): ELIRA_MODEL (default: claude-sonnet-4-6)
- Hermes (Steven mode): ELIRA_MODEL (shares Elira's reasoning depth)
- Agents (Alba, Vex, David): AGENT_MODEL (default: claude-sonnet-4-6)

## Memory Conventions
- All goal/floor data persists in SQLite at data/askelira3.db
- Workspace files persist in workspaces/[goal-id]/
- Logs are append-only
