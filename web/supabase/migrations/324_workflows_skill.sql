-- Migration 324: the Workflows skill, A1b (docs/plans/always-on-agent.md §1b
-- item 6). Seed only.
--
-- Chat's create_flow / update_flow now build every trigger and action the
-- Flows editor wires (src/lib/ai/tools/flows.ts): status, schedule, capture
-- and calendar triggers; HTTP, run-skill and archive-capture actions (run_agent
-- is refused while its dispatch is off). Every loop chat builds is saved off
-- until the person says yes (plan §6, "it asks first"), and the loop tools are
-- attended only (ATTENDED_ONLY_TOOL_NAMES): no background run holds them.
--
-- 1. Rewrites the Flows core on its 319 id (323 rewrote it once, saying chat
--    builds only HTTP status flows; no longer true):
--      1ef0c12f…  flows-playbook   the four triggers and four actions as the
--                 tools take them, the saved-off rule, update_flow's merge
--                 rules, and the still-true debugging notes (list_flow_runs,
--                 the loop guard, fire_on_agent_changes, dormancy, timeouts).
--    Same five headings as the other cores, at most about 2,000 tokens.
--
-- 2. Adds one recipe, tagged flows, pack-only (listed only in the Flows pack;
--    src/lib/chat/chat-run-rebuild.ts):
--      a1c4ac7d…  build-a-workflow  the asks-first build end to end:
--                 search_tools, the trigger, the actions, create (saved off),
--                 a one-line summary, then update_flow on the person's yes.
--
-- Gating: Flows is a gated feature, so the new row joins
-- FEATURES.flows.systemRecipeIds (src/lib/editions/manifest.ts).
--
-- src/lib/packs/__tests__/migration-324.test.ts pins this file, and
-- playbook-accuracy.test.ts holds both texts to the code. Eval cases:
-- src/lib/packs/skill-evals/cases/flows-playbook.ts and build-a-workflow.ts.
--
-- Idempotent, the 316/319/322/323 pattern: fixed ids, inserted when missing,
-- else updated only where they differ.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '1ef0c12f-5d78-41ef-ab12-714512fa03cd'::uuid,
    $name$Flows playbook$name$,
    $slug$flows-playbook$slug$,
    $icon$🔁$icon$,
    $color$#14b8a6$color$,
    $desc$How Dial8's flows (loops) work and how to build them safely: status, schedule, capture and calendar triggers, HTTP and skill actions, why one didn't fire. Loads by itself in flows.$desc$,
    $pb$How flows work in Dial8, and how to set up automations that do what the person expects.

## What's here
- A flow (also called a loop) is a workspace automation: one trigger and a list of actions, each with an optional condition. Every loop has a bot, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.
- Triggers, by `trigger.type`:
  - entity_status_change: an action, project, initiative or milestone reaching a status. An action loop belongs to the team of its `to_status_id` state.
  - schedule: `cadence` hourly, daily, weekdays or weekly, at `time` ("HH:mm", 24h) in `timezone` (an IANA zone; the person's own when left out), on `weekday` 0 (Sunday) to 6 for weekly. No cron expressions.
  - capture_processed: a meeting capture finishes processing.
  - calendar_event: `offset_minutes` before (negative) or after each occurrence of the recurring event whose title is `event_title` (any case), within a day either side.
- Actions, by `type`:
  - http_post calls a public `url`.
  - run_skill runs a skill by `skill` (slug or id). `mode` report, the default, can't change records and delivers a document and a notification; act may change records, as the skill would in chat. At most 2 enabled per loop.
  - archive_capture archives the capture that fired the loop: capture_processed only.
  - run_agent starts a coding agent; the tools refuse it while the server has it switched off, the usual case.
- Workspaces start with seeded loops: Triage after every capture (on), and Weekly groom, Commitment reconciler and Morning brief (off until switched on).

## How to find things
Every flows tool, `list_skills` and `list_workflow_states` need `search_tools` first.
1. `list_flows` reads every loop with its trigger, actions, conditions, on/off state and bot (bearer tokens are never shown, only whether one is set). Before building, check it for one that already does the job.
2. `list_flow_runs` (20 by default, up to 100, by `flow_id` or `status`) shows each fire with per-action results, the HTTP code, response and error.
3. `list_skills` gives a run_skill's slug; `list_workflow_states` gives an action trigger's state ids. Project, initiative and milestone triggers use status words (project: planned, active, paused, completed, canceled).
4. `show` with kind flows opens the Flows page for the person.

## Doing it well
- Building one follows the `build-a-workflow` skill: it asks first.
- Every loop `create_flow` makes is saved off. Tell the person the result's `summary` in one line, ask whether to switch it on and end your turn; on their yes, `update_flow` with `enabled` true and `confirmed_with_user` true. Switching a loop on, or changing the trigger or actions of one that's on, needs `confirmed_with_user`; set it only after the person's yes in this conversation. The person asking outright for that, about a loop they can see in `list_flows` or the Flows page, is the yes. Switching off never needs it.
- `update_flow` takes only what changes:
  - A `trigger` of the same type keeps the fields you leave out (send only `time`, say); another type replaces it.
  - `actions` replaces the whole list: re-send every action you keep, each with its `id`. A matched action keeps what you leave out (its skill, mode, auto-apply trust, document title, URL, stored `bearer_token`, `enabled`, `condition` and `parent_id`), so send only what changes: omitted keeps, null clears a `condition` or `parent_id`. Another skill starts fresh, in report mode.
  - On or off, a new name or a new bot: leave `actions` out.
- A refusal names the `field` and the fix: correct that and call again.
- HTTP: a public https `url` (localhost and private addresses are refused), `method` POST by default, `headers`, and a `body_template` filled from tokens such as `{{action.identifier}}`, `{{action.title}}`, `{{entity.name}}`, `{{capture.title}}` and `{{trigger.fired_at}}`; an unknown token renders empty. A secret goes in `bearer_token`, never in `headers`.
- A `condition` gates one action on the status change that fired the loop: match all or any rules on an action's label, priority, assignee or team, the project of an action or a milestone, or from-status (the status it left, on any status loop).
- Skills run in report mode unless the person asked the loop to change things.
- One loop, one job, named for it ("Post Done actions to #eng"). Prefer a condition over near-identical loops.

Why a loop didn't fire (`list_flow_runs`):
- A loop that's off never fires: check `enabled`.
- A run can say success with every action skipped: read `action_results`. Skipped with the condition not met means the condition blocked it.
- Status changes made by a background run don't fire a loop unless it opts in (`fire_on_agent_changes`, which these tools keep but can't set), and chains of automations stop after two steps. Project, initiative and milestone status changes made with the chat's tools don't fire loops at all; the same change made on the page does.
- A schedule skips its fires (recorded, no cost) when the workspace has had no new capture or edited action for two weeks. A calendar loop sleeps when the desktop hasn't synced the calendar for three days, or no upcoming event has the title.
- A request times out after 5 seconds, isn't retried, and anything but a 2xx is a failure: report the code and body preview.

## Pitfalls
- A condition reads only the status change that fired the loop: on a project or initiative loop only from-status filters, on a milestone loop from-status and project. On schedule, capture and calendar loops a rule can't filter (is, in and is_set never match; their opposites always do), so `archive_capture` archives every capture that fires it. Say so before building one.
- `delete_flow` deletes a loop and its run history for good: only when asked, after confirming. Switching it off is the reversible choice.
- Don't promise what the tools refuse (a cron expression, a run_agent action, a trigger on email): say what's possible instead.

## When to hand to a helper
Not yet: helpers come later, so do the work here.$pb$,
    $cfg${"enabled_tools": ["flows", "actions", "library"], "preferred_tools": ["list_flows", "create_flow", "update_flow", "list_flow_runs", "list_workflow_states", "list_skills"]}$cfg$::jsonb,
    'flows'
  ),
  (
    'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3'::uuid,
    $name$Build a workflow$name$,
    $slug$build-a-workflow$slug$,
    $icon$⚙️$icon$,
    $color$#14b8a6$color$,
    $desc$Turn a request like "every weekday at 9, brief me" or "after each meeting, run triage" into a loop: trigger, actions, saved off, switched on only after the person's yes.$desc$,
    $pb$Build an automation (a loop) from a request such as "every weekday at 9 send me a standup brief", and switch it on only after the person says yes.

## Steps
1. `search_tools` for the flows tools, `list_skills` and `list_workflow_states`: none are always there. Then `list_flows`: when a loop already does the job, change it with `update_flow` instead of building a twin.
2. The trigger:
   - On a clock: schedule with `cadence` (hourly, daily, weekdays or weekly), `time` "HH:mm" and, for weekly, `weekday` (0 Sunday to 6 Saturday). Leave `timezone` out to use the person's zone. There's no cron: "every two hours" or "the first Monday" can't be built, so offer the nearest cadence.
   - After a meeting: capture_processed.
   - Around a calendar event: calendar_event with `event_title`, the recurring event's title, and `offset_minutes` (-15 is 15 minutes before).
   - When something reaches a status: entity_status_change with `to_status_id`, for actions a state id from `list_workflow_states`.
3. The actions:
   - A skill: run_skill with `skill` (a slug or id from `list_skills`) and `instructions` for what this loop adds. `mode` report unless the person asked the loop to change things ("close", "move", "update"); then act.
   - A webhook: http_post with `url` and `body_template`, and any secret in `bearer_token`.
   - archive_capture only on a capture_processed loop, and only when the person wants every such capture archived: a condition can't look at a capture.
4. `create_flow` with a short `name`, the `trigger` and the `actions`. Leave `enabled` out: every loop is saved off. A refusal names the `field` and the fix: correct it and call again.
5. Tell the person the result's `summary` in one line (the trigger, what runs, the next run), ask in your reply whether to switch it on, and end your turn. Even when the request said "and turn it on", ask once after they've seen the summary.
6. On their yes: `update_flow` with `flow_id`, `enabled` true and `confirmed_with_user` true. Never set `confirmed_with_user` without that yes.

## Changing one
- On or off: `update_flow` with `enabled` alone. On needs `confirmed_with_user` true: the person asking outright to switch on a loop they can see in `list_flows` or the Flows page is the yes. Changing the trigger or actions of a loop that's on needs it too.
- Report to act, or another skill: re-send the whole `actions` list, each with its `id`, changing only what they asked.
- A new time: `trigger` with the same type and only `time`.

## When the editor is better
Send the person to the Flows page (`show` with kind flows) for a run_agent action (these tools refuse it), a long tree of chained actions they want to see and arrange on the canvas, or when they'd rather click through it themselves.$pb$,
    $cfg${"enabled_tools": ["flows", "library", "actions"], "preferred_tools": ["list_flows", "create_flow", "update_flow", "list_skills", "list_workflow_states"], "pack_only": true}$cfg$::jsonb,
    'flows'
  )
),
inserted AS (
  INSERT INTO public.recipe (
    id, workspace_id, name, slug, icon, color, description,
    system_prompt, agent_config, area,
    category, is_system, is_default, sort_order, visibility
  )
  SELECT id, NULL::uuid, name, slug, icon, color, description,
         system_prompt, agent_config, area,
         'skill'::public.recipe_category, true, false, 0, 'workspace'::public.recipe_visibility
  FROM skill
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
UPDATE public.recipe AS r
SET name          = p.name,
    slug          = p.slug,
    icon          = p.icon,
    color         = p.color,
    description   = p.description,
    system_prompt = p.system_prompt,
    agent_config  = p.agent_config,
    area          = p.area,
    updated_at    = now()
FROM skill AS p
WHERE r.id = p.id
  AND (r.system_prompt IS DISTINCT FROM p.system_prompt
       OR r.description IS DISTINCT FROM p.description
       OR r.agent_config IS DISTINCT FROM p.agent_config
       OR r.area IS DISTINCT FROM p.area
       OR r.slug IS DISTINCT FROM p.slug
       OR r.name IS DISTINCT FROM p.name
       OR r.icon IS DISTINCT FROM p.icon
       OR r.color IS DISTINCT FROM p.color);
