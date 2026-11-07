# Dev Environment Setup

One-time setup for the dev environment (the integration target between feature/agent branches and production). See [E2E_TESTING_AND_DEPLOYMENT.md](./E2E_TESTING_AND_DEPLOYMENT.md) for the full design.

End state:

| Branch | Vercel | Supabase | URL |
|---|---|---|---|
| `main` | Production deployment | Prod project | `dial8.ai` |
| `dev` | Branch deployment (same project, branch-scoped env vars) | Existing dev project | `dev.dial8.ai` |
| `agent/*` `feat/*` `fix/*` | Preview deployment | Existing dev project (until per-PR branching lands) | `*.vercel.app` |

---

## Step 1 — Create the `dev` branch

```bash
git checkout main
git pull
git checkout -b dev
git push -u origin dev
```

You already did this. ✓

---

## Step 2 — Reuse existing dev Supabase project

**No new project to provision.** The dev Supabase project you've been using for local development becomes the persistent backend for `dev.dial8.ai`. Migrations are already there.

Note these three values from the Supabase dashboard (Settings → API):

- Project URL (`https://<ref>.supabase.co`)
- Anon key
- Service role key (keep secret)

You'll paste them into Vercel in the next step.

### What about local development?

Two options:

- **Option A (simplest):** Local dev keeps pointing at the same Supabase project (the one now serving `dev.dial8.ai`). `.env.local` is unchanged. Risk: if you nuke data locally, you've nuked dev data too. Low risk while you're the only developer.
- **Option B (cleaner):** Run `supabase start` on your laptop for fully isolated local dev. ~10 min one-time setup. Switch to this the first time local work accidentally breaks `dev.dial8.ai`.

Default to A. Switch to B when it bites.

### Local eve sandbox (reference ingest)

Every eve agent has a sandbox, and a task message that carries a **file part** makes eve provision it to stage the file — the utility agent's reference-ingest calls (`reference/ingest`, PDF → reference wiki) do exactly that. Locally, `eve dev` tries microsandbox, then Docker. **If neither works, it falls back to auto-installing `just-bash`, which rewrites your checkout's `package.json` / `package-lock.json` and `node_modules`.** Before triggering a reference ingest under `npm run dev`, make sure microsandbox or Docker is running — or don't run reference ingest locally. If it happens: stop the dev server, `git checkout -- package.json package-lock.json`, and reinstall (or restore the `node_modules` symlink in a worktree).

### Anonymized prod data

Skipped — the dev project's existing data is already non-prod. Only relevant if you ever decide to sync real prod data into dev, which you probably won't.

---

## Step 3 — Configure Vercel (one script, end-to-end)

Everything in this step is automated by [`scripts/bootstrap-dev-env.sh`](../scripts/bootstrap-dev-env.sh):

```bash
npm i -g vercel@latest          # if you're on an older version
npm run bootstrap:dev
```

The script does all of this for you:

1. Verifies CLI version and links the project (if not already linked)
2. Prompts for the three Supabase values (or reads them from env vars — see below)
3. Adds three env vars scoped to **Preview / git branch: `dev`**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (marked `--sensitive`)
4. Attaches `dev.dial8.ai` to the project
5. Pins `dev.dial8.ai` to track the `dev` git branch

Idempotent — re-running is safe. Existing env vars are detected and replaced, not duplicated.

### Pass values via env vars (skip the prompts)

```bash
export DEV_SUPABASE_URL="https://xxx.supabase.co"
export DEV_SUPABASE_ANON_KEY="eyJ..."
export DEV_SUPABASE_SERVICE_ROLE_KEY="eyJ..."

npm run bootstrap:dev
```

Or all-in-one:
```bash
DEV_SUPABASE_URL=... DEV_SUPABASE_ANON_KEY=... DEV_SUPABASE_SERVICE_ROLE_KEY=... npm run bootstrap:dev
```

### Vars that should be the SAME across prod and dev

For things like Anthropic API key, Resend API key, etc., the script doesn't touch them. Vercel falls back to the existing Production-scoped value automatically for any preview deploy that doesn't have an override.

One to know about: `EXA_API_KEY` (from the Exa dashboard) powers the onboarding researcher's `research_company` tool — Exa's company-profile Deep Search, called directly at `api.exa.ai` because the AI Gateway's Exa tool can't express a deep search. Without it the researcher still runs; it just falls back to plain `web_search` / `web_fetch` for the company step.

### Other dev-specific env vars

If you need to add more dev-scoped vars beyond the three Supabase ones (Stripe test keys, separate Sentry DSN, etc.), either:

- Add them manually: `vercel env add VAR_NAME preview --git-branch=dev`
- Extend `scripts/bootstrap-dev-env.sh` (add a `set_env` line in step 2) so it's reproducible

### Manual fallback

If the script fails for any reason, do these by hand:

```bash
# Env vars
vercel env add NEXT_PUBLIC_SUPABASE_URL preview --git-branch=dev
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview --git-branch=dev
vercel env add SUPABASE_SERVICE_ROLE_KEY preview --git-branch=dev --sensitive

# Attach domain
vercel domains add dev.dial8.ai <project-name>

# Pin domain to branch (raw API — no first-class CLI command for this)
PROJECT_ID=$(jq -r .projectId .vercel/project.json)
vercel api -X PATCH "/v10/projects/$PROJECT_ID/domains/dev.dial8.ai" -F gitBranch=dev
```

### Trigger the first deploy

```bash
git checkout dev
git commit --allow-empty -m "chore: trigger dev deploy"
git push
```

Watch Vercel — a preview deploy kicks off, completes in ~2-3 min, and `dev.dial8.ai` serves the new build. Don't forget to update DNS at your registrar — `vercel domains inspect dev.dial8ai` will tell you what to set.

### What about PR previews?

PRs from other branches (`agent/*`, `feat/*`, etc.) get their own preview URLs and use Vercel's default **Preview** env vars (the ones *without* a `dev` branch filter). For now, those default Preview vars also point at the same dev Supabase, since we haven't built per-PR Supabase branching yet. That means PR previews currently share state with `dev.dial8.ai` — fine for the foundation phase, fixable later with the Supabase branching work.

---

## Step 4 — Update agent to target `dev`

In your scheduled task that creates agent PRs:

```ts
await gh.pulls.create({
  // ...
  base: 'dev',   // ← was 'main'
});
```

One line. Agent work now flows into `dev` instead of directly into prod.

Human contributors should also target `dev` for PRs. Exceptions:
- Hotfixes (target `main` directly, then cherry-pick back to `dev`)
- Updates to docs/CI that don't ship code

---

## Step 5 — Branch protection

GitHub repo → Settings → Branches → Add rule.

### Rule for `main`

- **Branch name pattern:** `main`
- ✅ Require a pull request before merging
- ✅ Require approvals: 1
- ✅ Require status checks to pass:
  - `Vercel — Preview` (runs `npm run build` which is `vitest run && next build` — catches unit tests, type errors, build failures)
- ✅ Require linear history
- ✅ Do not allow bypassing the above settings
- ✅ Restrict who can push to matching branches → add yourself + the `promote-to-prod` workflow's identity

### Rule for `dev`

- **Branch name pattern:** `dev`
- ✅ Require a pull request before merging
- ✅ Require approvals: 1 (set to 0 if you trust the agent + tests and want auto-merge)
- ✅ Require status checks to pass:
  - `Playwright` (from `e2e-preview.yml` — runtime tests against the Vercel preview)
  - `Vercel — Preview` (build + type errors + unit tests)
- ✅ Require branches to be up to date before merging
- (No linear-history requirement — squash-merge handles cleanup)

**Note on what's NOT a required check:**
- **No `Lint` check.** Next 16's build skips ESLint, so Vercel won't catch lint issues. The agent runs `npm run lint` pre-commit. If lint errors land on `dev`, fix them and re-push.
- **No standalone `Typecheck` check.** Vercel's `next build` includes `tsc` on bundled code, so type errors break the Vercel build → `Vercel — Preview` goes red. Scripts and tests aren't checked by Vercel — agent's `npm run typecheck` pre-commit covers those.

---

## Step 6 — Verify the foundation

1. **Open a PR against `dev`** with a trivial change.
2. CI fires: `pr-checks` + `e2e-preview` both kick off.
3. Vercel deploys a preview URL.
4. E2E runs against the preview, posts comment.
5. Merge the PR.
6. `dev` branch updates → Vercel deploys `dev.dial8.ai`.
7. `dev-deploy.yml` runs smoke tests against `dev.dial8.ai`.
8. Visit `dev.dial8.ai`, confirm the change is live.
9. Manually run the `promote-to-prod` workflow → `main` updates → `dial8.ai` redeploys.

If all six work, the foundation is solid.

---

## What's NOT done in this phase

- **Per-PR Supabase branches** — comes next. PRs currently share the dev Supabase project, so agent tests can collide. Plumbing works, isolation doesn't yet.
- **Dev-level exhaustive E2E suite** — needs the seed script + factories first.
- **Auto-revert on dev E2E failure** — manual for now.

---

## Required GitHub secrets after this phase

Repo Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEV_URL` | `https://dev.dial8.ai` |
| `PROD_URL` | `https://dial8.ai` |

(More secrets land when Supabase branching arrives.)
