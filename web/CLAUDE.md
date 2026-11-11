# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Production runs on our own server, and merging to `main` deploys nothing: read "How
production works" in [`../CLAUDE.md`](../CLAUDE.md) before calling a change live, applying a
migration or changing a production setting.

## Project Overview

Native Intelligence is a cross-platform workspace combining meeting capture, project management, and CRM — think Linear meets Granola. This repository contains the web application (Next.js) which serves both the marketing site and the full SaaS dashboard.

A companion desktop app (in `../desktop/`) provides native audio capture and meeting detection.

## Commands

```bash
npm run dev            # Start development server at http://localhost:3000
npm run build          # Production build (runs tests first)
npm run test           # Run test suite once
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Generate v8 coverage report
npm run lint           # Run ESLint on src/
npm run typecheck      # Standalone tsc --noEmit
```

## Conventions

### API routes — auth + error handling

Use the centralized helpers instead of hand-rolling auth/workspace checks:

```ts
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  // ... route logic
}
```

Error responses always use the helpers in `@/lib/api-errors` so they share
the `{ error, code?, details? }` shape. Many older routes still use the old pattern;
move them over when you touch them.

### AI model calls — every one runs on eve

Every server model call runs on an eve agent (`agents/*`, mounted at `/eve/<name>/v1/*`
in `next.config.mjs`): `chat-agent`, `skill-runner`, `coding-agent`, `work-agent`,
`live-agent`, `utility`, `onboarding-researcher` and `web-research` (a free user's web
research on their own ChatGPT plan). Never add an in-process
`generateText` / `streamText` / `generateObject` / `streamObject`. A one-shot generation
goes on the `utility` agent (`runUtilityTask` in `src/lib/eve/utility/run-utility.ts`).
The only exceptions are two eval grader files (`src/lib/evals/graders/judges.ts` and
`match-proposals.ts`, one `generateObject` call each) and embeddings (`embed()` /
`embedMany()`, plus the in-browser voice-embedding worker). The ChatGPT free tier's plan model
(`agents/*/lib/chatgpt-plan-model.ts`, one file copied byte for byte into each agent that runs a
free user, `createOpenAI` from `@ai-sdk/openai`) is the one provider import in the agents
(founder decision, 10-20): a free user's steps still run inside eve,
but on their own ChatGPT plan through the app's plan proxy, never the Gateway.
A phone call's voice layer is OpenAI's GPT-Live
(`src/lib/calls/live-api.ts` and `live-bridge.ts`: a raw fetch and the `ws` sideband, no
provider package; founder decision, 10-31, the calling spike): it only talks, in client
delegation mode, and every request it hands over runs as an eve chat-agent turn.
A new grader file is NOT exempt:
adding any file to the allowlist is a founder decision. `src/lib/ai/__tests__/eve-everywhere-tripwire.test.ts`
enforces this over `src/`, `agents/`, `scripts/`, `supabase/functions/` and `packages/`: it also
refuses `ToolLoopAgent`, `experimental_evaluate` and the other AI SDK model entry points,
`doGenerate` / `doStream`, any value import from `'ai'` (or an `'ai'` subpath) outside its
no-model-call allow-set, eve's in-process model modules (`eve/ai`, `eve/models/*`, `eve/evals`
whose `t.judge()` runs `evaluate()`, `eve/tools/agent-router`, and `auto` from
`eve/tools/approval`), any eve subpath not in its allow-set (eve fails closed, like `'ai'`), and
provider packages outside `src/lib/ai/gateway.ts` / `gemini-embeddings.ts` / the
voice-embedding worker. It also fails if a `*_EVE_RUNTIME` flag comes back. There are no runtime flags: eve is the only runtime.

Keep `src/lib/ai/tools/*`, `tool-discovery.ts`, `tool-schemas.ts` and
`tool-registry.ts`, because eve's tool proxies execute them through
`/api/internal/*/tool`. Keep the `@ai-sdk/react` `useChat` layer too, because the eve
transports implement it.

Internal secrets (app ⇄ agent services). `RUN_SKILL_INTERNAL_SECRET` is required: the
skill-runner reads it, and it is the fallback for every other secret. Each of the others
is optional in code and falls back to it, but must hold its own distinct value in prod
(the run tokens other than utility's have no domain prefix):
`AGENT_RUN_INTERNAL_SECRET` (coding-agent, work-agent, onboarding-researcher),
`CHAT_INTERNAL_SECRET` (chat-agent, `/api/device/ask`), `UTILITY_INTERNAL_SECRET`
(utility, web-research), `LIVE_AGENT_INTERNAL_SECRET` (live-agent), `LOCAL_AGENT_TOKEN_SECRET` (the Mac
body's `la1` tokens, `src/lib/local-agent/tokens.ts`) and `BROWSER_INTERNAL_SECRET` (the cloud
browser's relay token, `src/lib/cloud-browser/relay-token.ts`). An empty value counts as unset, so
the app-side resolvers (`src/lib/eve/internal-secret.ts`) log one `[internal-secret]` line per
family saying whether the key is `dedicated`, `shared` (equal to ANY other internal secret,
with `sharedWith` naming those env vars), `fallback` or `unset`, never a value.

### The risky-call reviewer

`src/lib/safety/action-review.ts` reviews every risky tool call (external-write, delete,
automation-write, external MCP) at the chat and skill-run tool routes and the Mac body's
tool route. Where it **blocks** is `ACTION_REVIEW_MODE`'s call (`src/lib/safety/review-mode.ts`):
- **unset or `default`:** blocking for the Native Intelligence agent on the person's Mac only. That's every
  call it makes (`mustEnforce`, or an approval naming its job in `context.localAgent`),
  including the jobs loops start. Everything that runs today stays log-only, as on PROD: the
  person's own turns, relays, server turns, and loops and skill runs that don't use the Mac.
  The reviewer's live eval (2026-10-21) carded
  most calls people plainly asked for, and scored a loop that keeps to its instructions at 0.22.
- **`blocking`:** every caller.
- **`shadow`:** no caller (the kill switch). Loops can't start Mac jobs, and a running loop
  job is refused and stopped at its next call (`src/lib/local-agent/unattended.ts`).
- **Any other value:** `blocking`.

A blocked call never runs: the person gets an approval card that says why (a chat-native
tool gets a `NEEDS_PERSON` refusal instead). A review that can't run (Jev down or slow) is a
hold, never a run. Setting the env var in production (the server's `deploy/app/.env`) is a
founder decision.

### Testing

Tests live under `__tests__/` directories next to the code they cover.
Shared helpers are in `src/test/`. See `docs/TESTING.md` for patterns.

Fixtures use made-up people, companies and numbers (`555-01xx`), never real contacts,
customers or inbox data. The open-source export (`scripts/open-source/export.sh`) builds
one public repo from this one (`web/`) and the desktop app (`desktop/`), and refuses to
build when a name from `scripts/open-source/denylist.txt` turns up in either.

## Architecture

### Tech Stack
- Next.js 16 (App Router), React 19, TypeScript
- Tailwind CSS with custom Switzer font
- Supabase (PostgreSQL, Auth, Realtime)
- Inngest for background workflows
- Stripe for payments
- Deepgram for transcription (via desktop app)
- Claude (Anthropic) and other Gateway models for AI features. Server model calls run on
  Vercel eve agents (`agents/*`, eve 0.79.1) through the Vercel AI Gateway; the eval graders
  and embeddings are the only exceptions

### Key Directories
- `src/app/account/` - Authenticated dashboard (actions, captures, email, calendar, CRM, etc.)
- `src/app/admin/` - Admin panel (users, campaigns, AI plans)
- `src/app/api/` - API routes (170+ endpoints)
- `src/app/docs/` - Documentation pages (Fumadocs)
- `src/components/` - Shared UI components
- `src/lib/` - Business logic (AI tools, OAuth, CRM, email, views)
- `agents/` - The eight mounted eve agents (every server model call runs here), plus `local-agent`, which runs on the user's Mac
- `content/docs/` - MDX documentation content
- `supabase/migrations/` - Database schema (59 migrations)

### Core Features
- **Workspaces & Teams** - Multi-tenant with roles and team-scoped workflows
- **Actions** - Task tracking with identifiers (ENG-42), custom workflow states
- **Captures** - Meeting recordings with AI extraction (actions, decisions)
- **Email** - Gmail/Outlook sync with AI-drafted replies
- **Calendar** - Multi-provider calendar with meeting-to-capture linking
- **CRM** - Contacts, companies, interaction history, voice identification
- **AI Assistant** - Claude-powered chat with 22+ workspace tools
- **Views** - Custom filtered views with list/board layouts

### API Routes (`src/app/api/`)
- `/api/account/*` - All workspace CRUD operations
- `/api/ai/*` - AI chat, capture processing, summarization, RAG
- `/api/oauth/*` - Google/Microsoft OAuth flows
- `/api/webhooks/*` - Gmail/Outlook push notifications
- `/api/cron/*` - Background jobs (email sync, campaigns, notifications)

## Styling

- Tailwind CSS with custom `Switzer` font family
- Dark mode enabled via `class` strategy
- Path alias: `@/*` maps to `./src/*`

## External Links

- Website: `nativeintelligence.dev` (the default of `NEXT_PUBLIC_APP_URL`, `src/lib/app-url.ts`); the hosted app also answers on `dial8.ai` while it moves
- Discord: `discord.gg/sHtYGtkWga`
- X/Twitter: `x.com/Dial8_ai`
