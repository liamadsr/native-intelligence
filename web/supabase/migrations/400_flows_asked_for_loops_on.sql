-- ============================================================
-- 400: the flows playbooks say a loop the person asks for is on. Seed text only.
-- ============================================================
-- Liam, 2026-10-20: "If I asked to create a flow and the agent created it,
-- there's no reason for it to be off." create_flow now saves a loop the
-- person asked for ON (`enabled` true), and only a loop the agent proposes
-- on its own is saved off for their yes (src/lib/ai/tools/flows.ts). The one
-- exception, Liam's decision: a loop with an http_post (webhook) step
-- switches on only from the person's approval card, which the call raises
-- in the chat (src/lib/flows/flow-approvals.ts needsSwitchOnCard; P13: an
-- approval asks in the chat, never in For you).
--
-- The two flows skills, seeded by 324_workflows_skill.sql (flows-playbook
-- rewritten by 338_skill_helper_lines.sql, with 357 and 361's sentence edits),
-- still teach "every loop is saved off, ask even when they said turn it on".
-- This replaces only those sentences, by exact replace(), and leaves every
-- other line as it is:
--   flows-playbook    the "saved off" paragraph of its How to build list;
--   build-a-workflow  its first line, steps 4 to 6, and its description.
--
-- Same rows and columns as 357/361: public.recipe.system_prompt (and
-- description), by id and slug, system rows only.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the playbooks keep teaching the old rule; create_flow follows
-- the new one either way.
--
-- Idempotent: each UPDATE is fenced on an old sentence being present, and no
-- new sentence contains an old one, so a second run changes nothing. No
-- backslash anywhere in this file (the MCP apply decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

UPDATE public.recipe
SET system_prompt =
      replace(system_prompt,
        $o$Every loop `create_flow` makes is saved off. Tell the person the result's `summary` in one line, ask whether to switch it on and end your turn; on their yes, `update_flow` with `enabled` true and `confirmed_with_user` true. Switching a loop on, or changing the trigger or actions of one that's on, needs `confirmed_with_user`; set it only after the person's yes in this conversation. The person asking outright for that, about a loop they can see in `list_flows` or the Flows page, is the yes. Switching off never needs it.$o$,
        $n$A loop the person asks for (or says yes to when you offer it) is created on: `create_flow` with `enabled` true, then tell them the result's `summary` in one line and that they can switch it off. One you'd suggest on your own: leave `enabled` out (it is saved off), tell them the summary, ask once and end your turn; on their yes, `update_flow` with `enabled` true and `confirmed_with_user` true. A loop with an http_post (webhook) step switches on only from the person's approval card, which the call raises in the chat, right under your message. Switching a loop on later, or changing the trigger or actions of one that's on, needs `confirmed_with_user`: the person asking outright for that, about a loop they can see in `list_flows` or the Flows page, is the yes. Switching off never needs it.$n$),
    updated_at = now()
WHERE id = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'::uuid
  AND slug = 'flows-playbook'
  AND is_system
  AND strpos(system_prompt, $o$Every loop `create_flow` makes is saved off.$o$) > 0;

UPDATE public.recipe
SET system_prompt =
      replace(replace(replace(replace(system_prompt,
        $o$Build an automation (a loop) from a request such as "every weekday at 9 send me a standup brief", and switch it on only after the person says yes.$o$,
        $n$Build an automation (a loop) from a request such as "every weekday at 9 send me a standup brief". The person asked for it, so it is on as soon as it is built.$n$),
        $o$4. `create_flow` with a short `name`, the `trigger` and the `actions`. Leave `enabled` out: every loop is saved off. A refusal names the `field` and the fix: correct it and call again.$o$,
        $n$4. `create_flow` with a short `name`, the `trigger`, the `actions` and `enabled` true. A loop with an http_post (webhook) step is saved off and switches on only from the person's approval card, which the call raises in the chat, right under your message. A refusal names the `field` and the fix: correct it and call again.$n$),
        $o$5. Tell the person the result's `summary` in one line (the trigger, what runs, the next run), ask in your reply whether to switch it on, and end your turn. Even when the request said "and turn it on", ask once after they've seen the summary.$o$,
        $n$5. Tell the person the result's `summary` in one line (the trigger, what runs, the next run) and that they can switch it off any time; for a webhook loop, that its approval card is just below in the chat.$n$),
        $o$6. On their yes: `update_flow` with `flow_id`, `enabled` true and `confirmed_with_user` true. Never set `confirmed_with_user` without that yes.$o$,
        $n$6. A loop you'd suggest on your own, not one they asked for: leave `enabled` out, show the summary and ask once; on their yes, `update_flow` with `flow_id`, `enabled` true and `confirmed_with_user` true. Never set `confirmed_with_user` without that yes.$n$),
    description =
      replace(description,
        $o$Turn a request like "every weekday at 9, brief me" or "after each meeting, run triage" into a loop: trigger, actions, saved off, switched on only after the person's yes.$o$,
        $n$Turn a request like "every weekday at 9, brief me" or "after each meeting, run triage" into a loop: trigger and actions, on as soon as the person asks for it.$n$),
    updated_at = now()
WHERE id = 'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3'::uuid
  AND slug = 'build-a-workflow'
  AND is_system
  AND (strpos(system_prompt, $o$Leave `enabled` out: every loop is saved off.$o$) > 0
       OR strpos(description, $o$saved off, switched on only after the person's yes.$o$) > 0);
