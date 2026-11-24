# The Dreamer: a background researcher for the main agent

Status: built (2026-11-24). Liam asked for it, with its prompt in our own words.

## Why

On 2026-11-24 the agent pinged Liam twice about mail from a contact during his call with that contact. Each ping said "I haven't opened it", because:

- the event turn is told to stay out of the mail;
- it gets only the sender's address and a thread id.

The automatic drafter also wrote "I'm here and ready for our call" for him, while he was already on it.

The main agent knows too little about the person's day when it speaks. The Dreamer fixes the knowing: a few times a day it reads mail, calendar, calls and actions in depth, keeps notes, and reports to the main agent (the parent). Only the parent decides what to tell the person.

The event turn and the drafter keep their own fixes. They are not part of this plan.

## What it is

- **A background helper of a new server kind, `dreamer`.** It runs on the work-agent through `startServerHelper` (`src/lib/chat/start-helper.ts`).
- **Its instructions are the Dreamer prompt**, in our own words: `src/lib/dreamer/prompt.ts`. `DREAMER_ROLE` is its standing role. `dreamerRunInstructions(run)` is the run's task: its start, the local time, whether it is the nightly reflection, and six steps (catch up, plan, research, keep notes, report, reflect). Checkpoints go to `/agent_notes/runs/YYYY-MM-DD/HH-mm-ssZ.md`, reflections to `/agent_notes/reflections/YYYY-MM-DD.md`; only run checkpoints older than 14 days are deleted.
- **It reports only to the parent.** `notify_parent` stores the report and starts a background update in the home thread, reason `dreamer`. The person never sees the report itself, only what the parent chooses to say.
- **It runs four times a day plus once at night:**
  - Heartbeat at 07:00, 11:00, 15:00 and 19:00 local time.
  - The reflection run at 03:00 local. It is skipped when the person's zone is only the UTC fallback, as the look-ahead does.

## Schedule and gates

- **The trigger.** The hourly scan in `src/lib/inngest/agent-events.ts` (`agentEventDigest`, `findDigestCandidates`) adds the Dreamer's hours, like the look-ahead does.
  - For each candidate at a Dreamer hour it sends `dreamer/run.requested`, id `dreamer:<user>:<workspace>:<local date>:<hour>`.
  - The event carries `{ userId, workspaceId, timeZone, localDate, hour }`.
- **The consumer** is `dreamerRun` (`src/lib/inngest/dreamer.ts`): concurrency 1 per user and 5 overall, registered in `src/app/api/inngest/route.ts`.
- **Its gates, in order.** Each skip returns a templated reason and is logged.
  1. The person has a home thread (`chat_conversations.is_home`).
  2. The agent isn't paused: `readAgentPausedState` must be `'active'`, which fails closed.
  3. The workspace isn't dormant (`workspaceIsDormant`).
  4. Autonomy isn't off, the same check `planHomeTurn` makes.
  5. The person is within usage limits (`checkUsageLimits`).
  6. The admission RPC holds the caps: at most one Dreamer working per person, at most 6 a UTC day. `fire_key` is the event id, so a retried event never starts a second run.
- **The model** is the Think tier, a server start's cap.

## The run

- **How it starts.** `startServerHelper` with `kind: 'dreamer'`, `quiet: true` (no pushes, agent log or inbox events), the Dreamer's ceiling, and `taskPrompt` set to `DREAMER_ROLE` + `dreamerRunInstructions(...)`.
- **How it starts its spec.** `runStartSection` (`src/lib/agent-run/run-work-spec-rebuild.ts`) gets a `dreamer` variant. It never says "a person asked for this". It says: "Native Intelligence started this run on a schedule. Nobody is watching and nobody will answer a question: never ask one."
- **What it may call** is `dreamerChatCeiling()`:
  - the server helper's reads (`serverHelperChatCeiling()` minus `SERVER_HELPER_WRITE_TOOLS`);
  - `read_parent_thread`;
  - the five notes tools;
  - `notify_parent`.
  - No `create_email_draft`, `create_document` or `propose_document_edit`.
- **Nothing the person can see.** A Dreamer run never writes a teammate report, in any status, and never lands in the review pile: it settles `done`. The places to branch on `server_helper === 'dreamer'`:
  - `src/lib/work/recorder.ts`, where reportable statuses call `reportToChat`;
  - `src/lib/work/agent-run-mirror.ts`, where `needs_review` and the meeting-prep exception are decided.
  - Its `tracked_job` row stays, muted.

## The tools (registry, `src/lib/ai/tools/dreamer-notes.ts`)

| Tool | Side effect | Who | What |
|---|---|---|---|
| `read_parent_thread` | read | Dreamer | The home thread's recent messages as text (`renderHomePrimer`, else `renderConversationPrimer`), fenced as data. Takes `{}`. |
| `list_agent_notes` | read | Dreamer, main chat | `{ path_prefix?, after_path?, limit? }`, returns `{ files: [{ path, updated_at, size }], next_after_path }` in path order. Includes the read-only files below. |
| `search_agent_notes` | read | Dreamer, main chat | `{ query, path_prefix?, limit? }`, a text search over bodies, giving paths and a short excerpt. |
| `read_agent_notes` | read | Dreamer, main chat | `{ paths: string[] }` (1–10), returns each file's body and `updated_at`, or `not_found`. |
| `write_agent_notes` | internal-write | Dreamer only | `{ path, content }`. Replaces the whole file. The path must start with `/agent_notes/`. Body up to 64 KB. |
| `delete_agent_notes` | internal-write | Dreamer only | `{ paths: string[] }`, only under `/agent_notes/`, exact files, never a folder. |
| `notify_parent` | internal-write | Dreamer only | `{ prompt }`, up to 16,000 characters. Once per run: a second call is refused. Stores the report and sends `home/turn.requested`, reason `dreamer`. |

**Read-only files** served by the notes tools (writes and deletes there are refused):

- **`/user_notes/profile.md`:** what the parent remembers about the person. That's `loadProfileFacts` plus their `<remembered>` lines from `loadPackMemory`, each fenced as quoted data.
- **`/action_items.md`:** the parent's Now file (`loadNowSection`).

**Who may call what:**

- **Main chat:** gets the three read tools, so the parent can dig into a report's notes.
- **Every other ceiling** refuses the four Dreamer-only tools. That covers channel turns, team chat, teammates, guests, other helpers, home turns, the check-in and the Mac body.

## Storage (migration 720, re-list main's migrations before merging)

- **`agent_note`** (one row per file):
  - **Columns:** `id`, `workspace_id`, `user_id`, `path` (`^/agent_notes/[A-Za-z0-9._/-]{1,240}$`, no `..`, no trailing `/`), `body` (≤ 65,536 characters), `created_at`, `updated_at`.
  - **Uniqueness:** `(workspace_id, user_id, path)`.
  - **RLS:** the owner can select. Writes go through the service role only, from the tool route.
- **`dreamer_report`:**
  - **Columns:** `id`, `workspace_id`, `user_id`, `agent_run_id` (unique: one report per run), `prompt` (≤ 16,000), `created_at`, `delivered_at`, `home_turn_id`.
  - **RLS:** owner select only.
- **`agent_run`:**
  - **Server helper kind:** `'dreamer'` added to `agent_run_server_helper_shape`.
  - **Admission RPC:** `start_chat_helper` (current definition `443_now_follow_up.sql`) accepts the kind, with the caps above.
- **`home_turn`:** `home_turn_reason_check` adds `'dreamer'` (latest definition `474_team_chat.sql`).

## The parent's side (home turn reason `dreamer`)

These change together, the way the check-in's did:

- `src/lib/chat/home-turn.ts`: the reason, its parse, the dedupe key `dreamer:<report id>`, `DREAMER_GUIDANCE` and a `buildHomeTurnBody` case.
- `home-turn-server.ts` `planHomeTurn`.
- `chat-run-token.ts` `HOME_TURN_TOKEN_REASONS`.
- `chat-ceiling.ts`: `HOME_TURN_ACTING_REASONS` gains it.
- `agents/chat-agent/lib/auth.ts`.
- `src/lib/reach/route-policy.ts`.
- The post-steps in `src/lib/inngest/home-turn.ts`.
- The migration tests that pin the reason list.

**How it runs.** The plan reads the person's undelivered `dreamer_report` rows from the last 24 hours, oldest first, at most 3. The body is `renderBackgroundUpdate` with one line per report, each the report text made inert, inside the data fence. A report from the 3 am run is marked "(nightly reflection)": `dreamer_report.reflection` is set from the run. After the turn, the rows are marked delivered (`delivered_at`, `home_turn_id`), whether the parent spoke or stayed quiet.

**This home turn can open the notes.** It holds the three notes reads (`list_agent_notes`, `search_agent_notes`, `read_agent_notes`), so the parent can open what a report links to.

`DREAMER_GUIDANCE`:

> Your background researcher (the Dreamer) finished a run and reported to you. The person has not seen its report; it is for you, and you can open the notes it links with read_agent_notes (find it with search_tools).
>
> Use it: tell the person now only what needs them soon (a P0 item, or anything they must know or act on before about 10 am tomorrow), time-sensitive first, in ONE short message that says what it is and where it waits. Everything else is context you keep: tracking it needs no message.
>
> If their calendar shows them in a meeting now, hold anything that can wait until it ends. A nightly reflection report is for your memory: don't message them about it unless something in it is time-sensitive.
>
> Act on what you can: unlike a helper's report, this one may start a background helper (start_helper) to draft a reply or prep a meeting, and sends are set up so they wait for the person's yes. Facts it suggests remembering or adding to the Now file can't be saved from a background update: bring them up when the person is next here.
>
> Never repeat what you already told them. If nothing needs them now, call no_reply and write nothing.

**`/action_items.md` carries each Now line's `track` key** (the item's kind and id) next to its line number. Line numbers change with each revision, so the key is the "exact ID" the Dreamer cites.

It is followed by `MARK_URGENT_GUIDANCE` and `ACT_ON_YOUR_OWN_GUIDANCE`.

## Tests

- **The prompt:** the test pins the rules that keep it safe, our tool names and note paths, and the run's context.
- **Notes tools:** path rules; the read-only files; replace-whole-file; paging with `next_after_path`; delete refuses folders and anything outside `/agent_notes/`; `notify_parent` works once per run and is refused outside a Dreamer run.
- **Ceilings:** the Dreamer-only tools are refused in every other ceiling; the main chat holds the three reads; the Dreamer holds no draft or document write.
- **Schedule:** the Dreamer's hours, the UTC-fallback skip at 03:00, and each gate's skip.
- **Suppression:** a Dreamer run writes no teammate report in any status and settles `done`.
- **The home turn:** the reason parses, its body carries the reports as data, and its rows are marked delivered.
- **Migrations:** the pinned reason and server-kind lists, and PGlite applies 720 twice.

## Not in this plan

- The Follow-up Dreamer and the Personal Scratchpad Space (we have neither).
- A setting to switch it off for one person: the agent's pause switches it off.
- The event turn's and the drafter's own fixes.
