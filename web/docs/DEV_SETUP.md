# Dev Environment Setup

Local development is `npm run dev` against a Supabase project of your own: the
[README](../README.md) has the steps ("Running it locally") and
[`.env.example`](../.env.example) the variables. Nothing but production is deployed,
and production runs on our own server: [`deploy/README.md`](../../deploy/README.md).
A merge to `main` deploys nothing by itself.

## Local eve sandbox (reference ingest)

Every eve agent has a sandbox, and a task message that carries a **file part** makes eve provision it to stage the file — the utility agent's reference-ingest calls (`reference/ingest`, PDF → reference wiki) do exactly that. Locally, `eve dev` tries microsandbox, then Docker. **If neither works, it falls back to auto-installing `just-bash`, which rewrites your checkout's `package.json` / `package-lock.json` and `node_modules`.** Before triggering a reference ingest under `npm run dev`, make sure microsandbox or Docker is running — or don't run reference ingest locally. If it happens: stop the dev server, `git checkout -- package.json package-lock.json`, and reinstall (or restore the `node_modules` symlink in a worktree).
