# E2E Testing & Deployment Pipeline

Design doc for the UI test suite, branching strategy, and deployment pipeline.

Status: **Design — not yet implemented.**

---

## Goals

1. Run UI tests remotely as part of CI/CD to catch regressions before they reach prod.
2. Support the agent-driven development flow (Dial8 MCP creates PRs → tests run → results returned to agent for retry).
3. Keep test infra clean — no piles of orphaned branches, workspaces, or test data.
4. Tier testing depth by environment so PRs get fast feedback and dev gets exhaustive coverage.

---

## Cross-app architecture

The desktop app (`../dial8-desktop`) is a **Tauri shell that loads `https://dial8.ai` as its webview**, plus a Rust core exposing native commands (audio capture, meeting detection) over IPC. It is **not** a separate frontend.

### Test tiers

| Tier | Lives in | Runs | Covers |
|---|---|---|---|
| Web E2E | this repo | per-PR | Everything a user sees in the dashboard |
| IPC contract | this repo (types) + desktop repo (validator) | per-PR in both | Web ↔ Rust command/event contract |
| API contract | this repo | per-PR | `/api/desktop/*` request/response shapes |
| Desktop smoke | desktop repo | nightly + pre-release | Native-only flows: recording, permissions, updater |

### IPC contract location

`src/lib/desktop/ipc.ts` in **this repo** is the source of truth. Exports TS types for every Tauri `invoke()` call and `listen()` event. Desktop repo imports as types and has a Rust test that validates `#[tauri::command]` signatures against a JSON schema generated from these types.

### What we deliberately don't cross-app test

- Audio bytes round-tripping through Deepgram (slow, non-deterministic)
- Real Zoom/Meet windows for meeting detection in CI (mock at Rust trait level)
- Tauri auto-updater end-to-end (test endpoint JSON shape, trust Tauri)

---

## E2E framework: Playwright

- Tests live in `e2e/` at repo root
- `playwright.config.ts` reads `BASE_URL` so the same suite runs locally or against preview URLs
- Parallelized across workers, trace + video on failure

---

## Test data strategy

### The problem

- Shared mutable test account → tests step on each other (rename "Q1 Launch" → other tests fail)
- Per-test workspace creation in shared dev DB → accumulating cruft, slow setup
- Empty Supabase branches per PR → tests need seeded fixtures

### The answer: seed-as-code, restore-as-data

Two artifacts kept in sync:

1. **`scripts/seed-e2e.ts`** — TypeScript source of truth. Uses service-role client to build the world via real API/inserts. Human-readable, code-reviewed. New feature → add 10 lines here.
2. **`e2e/fixtures/seed.sql`** — `pg_dump --data-only --inserts` of the result. Checked in. CI restores in ~10s.

You never edit `seed.sql` by hand. Edit the script, run `npm run seed:rebuild`, commit both.

### Workflow for adding seed data

```
Add a feature (new entity type, etc.)
  → Update seed-e2e.ts (add fixture data)
  → npm run seed:rebuild  (regenerates seed.sql locally)
  → git diff e2e/fixtures/seed.sql  (sanity check)
  → Commit script + SQL together
  → PR review sees: "script change makes sense, SQL diff matches"
```

If someone ships a feature without updating the seed, their tests have to create the entity from scratch every time — annoying enough that the convention enforces itself.

### Seed script contents (baseline)

- 3-5 test users with known emails (`alice@e2e.dial8.ai`, etc.) and known passwords, created via Supabase Admin API (not raw inserts) so password hashes work after `pg_dump`.
- 1 workspace ("Acme Test Co")
- 2-3 teams (Engineering, Design) with identifier prefixes
- 4-5 projects in various statuses
- 30-50 actions across workflow states, some assigned to projects
- 5-10 captures with extracted actions/decisions
- A handful of contacts, a cycle in progress, a few views

### Per-test isolation

- **Read tests** use seeded fixtures directly (navigate to seeded project, assert content).
- **Write/mutation tests** create their own scratch entities within the seeded workspace using API factories (`e2e/factories/`). No UI setup — too slow, breaks for unrelated reasons.
- **Auth**: storageState per user saved in `global-setup`, reused across tests.

### Factories

`e2e/factories/` — thin wrappers around real API routes using test-user sessions:

- `workspace.ts` — `createWorkspace()`, `createWorkspaceWithProject()`
- `action.ts` — `createAction()`, `createActionsInStates()`
- `capture.ts` — `createCapture()`, `createCaptureWithExtractions()`
- `project.ts` — `createProject()`, `createProjectWithActions()`

New factories added when a test needs them — not preemptively.

---

## Supabase branching lifecycle

### Per-PR flow

```
PR opened
  ├─ Create Supabase branch: e2e-pr-{N}    ← deterministic name
  ├─ Wait for migrations to auto-apply     (~20s)
  ├─ psql < e2e/fixtures/seed.sql          (~10s)
  ├─ Wait for Vercel preview ready
  └─ Run Playwright against preview + branch
PR closes/merged → webhook deletes branch
Nightly cron sweeps orphans
```

### Five guardrails for cleanliness

**1. Deterministic naming.** Branches are always named `e2e-pr-{prNumber}`. Never random. Lets CI check "does a branch exist for PR #142?" and reuse it.

**2. Reset, don't recreate, between CI runs on the same PR.** Agent pushes new commits → reset existing branch (~10s) instead of creating a new one (~30-60s).

**3. PR-close webhook deletes the Supabase branch.** Primary cleanup mechanism. Runs on merge or close.

**4. Nightly cron sweeps orphans.** Catches whatever the webhook missed (CI failures, network blips, manual deletions). Deletes any `e2e-pr-N` branch where PR #N is closed or branch is >48h old.

**5. Hard cap per agent ticket.** Agent retries on test failure but caps at 5 attempts, then hands off to human. Prevents infinite thrash.

### Reset-from-dev for long-lived agent PRs

If an agent PR sits open for days and 10 migrations land on dev, the agent's Supabase branch has stale schema. CI **resets the branch from dev's current state** on every run, not from `main`. Agent always tests against latest schema.

---

## Agent integration

### Lifecycle: one ticket → one PR → one branch

```
Action GEN-42 → "Todo"
  ↓
Agent creates branch agent/gen-42 from dev HEAD
  ↓
Agent opens PR #N targeting dev (link_pr to GEN-42)
  ↓
CI: provision branch, seed, deploy preview, run Playwright
  ↓
Post results as PR comment with <!-- e2e-results --> marker
  ↓
Agent reads marker comment:
  - Pass → move GEN-42 to "Ready for Review"
  - Fail (attempts < 5) → push fix to SAME branch, loop
  - Fail (attempts = 5) → move GEN-42 to "Needs Review" with note
```

The agent iterates on the **same** PR, the **same** branch, the **same** Supabase branch. Never opens new PRs per attempt.

### Concurrency rules

- **CI concurrency:** `cancel-in-progress: true` on group `e2e-pr-{N}` — new push cancels stale run.
- **Migration collisions:** Either reserve migration numbers via API before agent starts work, or use timestamp-based names (`20260524_120000_*.sql`) so collisions are impossible.
- **Merge conflicts:** Agent rebases onto dev before each test run. If rebase fails, marks PR `needs human merge` — agent does **not** try to resolve conflicts.

### Results format

```json
{
  "status": "fail",
  "total": 47,
  "failed": [
    {
      "name": "assigning an action to a project shows it in project actions tab",
      "error": "Locator not found: text=Wire auth",
      "trace": "https://github.com/.../trace.zip"
    }
  ]
}
```

Posted as a PR comment with `<!-- e2e-results -->` marker. CI **updates** the existing comment on re-runs (doesn't append). Agent polls open PRs it created, parses the marker, decides next action.

---

## Branching strategy

### Three long-lived branches, three environments

| Branch | Environment | URL | Supabase | Deploy trigger |
|---|---|---|---|---|
| `main` | Production | `dial8.ai` | Prod project | Manual promote from dev |
| `dev` | Dev | `dev.dial8.ai` | Dev project (persistent) | Auto on merge to `dev` |
| `agent/*` `feat/*` `fix/*` | Preview | Vercel preview URL | Ephemeral `e2e-pr-{N}` branch | Auto on push |
| `hotfix/*` | Preview → Prod | Vercel preview URL | Ephemeral branch | Targets `main` directly |

### Why not also a separate "staging" between dev and prod

For a small team, a single integration branch (`dev`) between feature branches and `main` is enough. A four-tier setup (`feature` → `dev` → `staging` → `main`) makes sense at larger scale where staging is a release candidate frozen for QA, but it adds an extra promotion step and another set of env vars to manage. Add it if/when you need it — for now, `dev` is the integration target and `main` is production.

### Promotion rules

**PR → dev:**
- All checks pass: typecheck, lint, unit, PR-level E2E
- Squash and merge (clean dev history)
- Auto-deploys, dev E2E runs

**dev → main:**
- Manual (human clicks "promote" button)
- Fast-forward only — `git merge --ff-only dev`
- Cadence: daily, or whenever dev has 3-10 changes and tests pass
- One person, one click, two minutes a day

### Hotfix lane

```
hotfix/auth-bug → PR against main directly
  → PR-level E2E runs
  → Squash merge to main → prod deploys
  → Cherry-pick onto dev immediately
```

Rare. Maybe monthly. Designed in upfront so it's not improvised under pressure.

### Branch protection

- **`main`**: linear history, all status checks required, no force push, restricted pushers (release manager + emergency).
- **`dev`**: PR review required, status checks required (PR-level E2E + unit + lint + typecheck), force push by maintainers only for revert scenarios.

### Agent PR targeting

Update agent scheduled task to open PRs against `dev`, not `main`:

```ts
await gh.pulls.create({
  // ...
  base: 'dev',   // ← was 'main'
});
```

One-line change.

---

## Test suites by environment

| Suite | Where | Duration | Coverage |
|---|---|---|---|
| **PR-level** | Per preview | ~5 min | Auth, workspace, critical paths, area touched by PR, all unit tests |
| **Dev-level** | Per dev deploy + nightly | ~20-30 min | All PR-level + capture lifecycle + AI tools + multi-user flows + email/calendar OAuth + visual regression + perf budgets + migration safety |
| **Production smoke** | Post-deploy | ~2 min | Homepage, login, dashboard, canonical capture page |

Rationale:
- Fast PR feedback (agent doesn't wait 30 min)
- Expensive tests (visual regression, full OAuth) run less often, on a stable target
- Production smoke catches deploy-only issues (env var typos, build artifact bugs)

---

## Dev Supabase setup

- **Reuses the existing dev Supabase project** (the one you were already using for local development). Persistent, separate from prod.
- **Migrations apply** via your normal `supabase db push` flow when schema changes land on `dev`.
- **Migration rollback rehearsal:** dev is the safety net — broken migrations surface here, not in prod.
- **Anonymized prod-data copy** is optional and not currently needed — dev project's existing data is non-prod. Only revisit if you start syncing prod data over.

---

## End-to-end lifecycle

```
1. Agent picks up GEN-42, creates agent/gen-42 from dev HEAD
2. Agent opens PR #142 targeting dev
3. CI:
     - Supabase branch e2e-pr-142 created (from dev schema)
     - Seed restored
     - Preview deploys
     - PR-level E2E runs (~5 min)
     - Results posted to PR with <!-- e2e-results --> marker
4. Agent reads results:
     - Pass → moves GEN-42 to "Ready for Review"
     - Fail → pushes fix to same branch, GOTO 3 (cap 5 attempts)
5. Human reviews PR, squash-merges to dev
6. Supabase branch e2e-pr-142 deleted via webhook
7. Dev deploys, dev-level E2E runs (~20 min)
     - Pass → GEN-42 moves to "Ready for QA"
     - Fail → auto-revert merge, ping engineering
8. Daily 9am: release manager reviews dev change list (auto-posted to
   Dial8 as a capture), smoke-tests UI, fast-forwards dev → main
9. Prod deploys, prod smoke runs (~2 min)
10. Released actions move to "Done"
```

---

## Auto-generated dev release list

On every push to `dev`, a GitHub Action posts a Dial8 capture titled "Dev release — manual QA list" with the diff of PRs merged since last prod release. Dogfoods Dial8, gives release manager a structured worklist.

---

## Implementation order

Foundation first, then layer on:

1. **Week 1:** Create `dev` branch + add `dev.dial8.ai` branch-deploy in existing Vercel project (reuses existing dev Supabase project as the persistent backend). Verify basic three-environment flow works.
2. **Week 2:** Playwright scaffolding + `seed-e2e.ts` script + `e2e/fixtures/seed.sql` generation + a handful of smoke tests against preview deployments.
3. **Week 3:** Supabase branching per PR (provision/reset/delete workflows + nightly cron).
4. **Week 4:** Agent integration — change agent to target `dev`, results-to-comment workflow, agent polling.
5. **Week 5+:** Expand test coverage. Add dev-level suite. Add visual regression. Add IPC contract layer with desktop repo.

---

## What we deliberately defer

- `dev` environment (skip entirely)
- Tauri WebDriver smoke suite (until a desktop regression slips through other tiers)
- Auto-promotion dev → prod (manual gate stays)
- Push-model agent webhook (start with pull, switch if iteration speed matters)
