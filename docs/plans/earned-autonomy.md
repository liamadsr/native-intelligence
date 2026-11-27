# Earned autonomy

Status: building (2026-11-27). The owner answered the decisions the same day (below);
phases 1 to 3 are approved, phase 3 behind `EARNED_AUTONOMY=graduate`, off by default. Roadmap issue #14: "The agent
takes over recurring work as it earns your trust, until it runs most of the day-to-day on
its own." The owner said "let's do it" (Liam, 11-27).

Nothing lets an outward action run without a card unless `EARNED_AUTONOMY=graduate` is set
on the server (the owner's call) and the person said yes to that one kind.

## Where it plugs in (what exists today)

- **Every outward call meets one policy.** `decideAction(caller, 'outward', tool)` in
  `src/lib/safety/caller.ts`, which `holdOutward` (`src/lib/safety/action-review.ts`) asks
  for every hold the outward gate (`outward-gate.ts`) makes. Today it returns `ask` for the
  person, a flow step and a home turn (a card), and `deny` for any other unattended caller.
  That is the one place where a graduated kind would answer `run` instead.
- **Every card's answer goes through two functions.** `approveToolCall` and `denyToolCall`
  (`src/lib/safety/approvals.ts`), whether the person clicks in the app or answers by a
  channel (`settle-card.ts`, `channel-approvals.ts`). Lapsed cards go through
  `expireLapsedApprovals`. A flow step's Accept can carry the person's edit (F4,
  `acceptableEdit`): both the stored input and the edit are in hand there. That's where the
  track record is written.
- **Standing yeses already exist, per tool and per person:** a connected app's "Always
  allow" (`mcp-client/always-allow.ts`) and a guest's tool the owner set to Always allow
  (`DecideOptions.guest.allowed`; Liam, 11-02: "I get to control who can do that"). Earned
  autonomy is the same kind of grant: the person's own yes, given once per kind. The
  difference is that the agent proposes it from a record, and the record can take it away.
- **What only reduces autonomy:** the role breaker (`work/role-breaker.ts`), the workspace
  kill switch (`agent_autonomy.mode = 'off'`), `ACTION_REVIEW_MODE`. All of them stay above
  this design. None of them is loosened.

## 1. A track record per kind of work

**The kind is computed by server code from the held call, never from model text.** A
model-written label ("this is just a booking confirmation") could be steered by an
injected email into a graduated kind. So the kind is derived deterministically from what
the gate already holds, the tool and its stored input:

    kind = tool × channel × audience

- **tool:** the bare registry name (`book_quote`, `create_calendar_event`,
  `push_action_to_linear`), or `mcp__<server>__<tool>` for a connected app's tool. Most of
  the examples are already one tool each. "Reply confirming a booking time to an existing
  customer by text" is `book_quote` by text. "File an email under a label" is a connected
  mailbox's label tool. "Create a task from a meeting" is an internal kind (phase 5).
- **channel:** how it leaves: `email`, `text`, `calendar`, `app:<server>` (a connected
  app), `link`, or `native` (it stays in Native Intelligence or the person's own tools, such
  as a push to Linear). It's read from the tool and its input (`offer_times`'s `channel`, a
  quote reply's channel on its approval context). When it can't be read, the channel is
  `unknown`, and an `unknown` kind never graduates.
- **audience:** how many people it reaches: `none`, `one`, `few` (2 or 3), `many` (more than
  3). It's counted from the recipients in the stored input (attendees, `to`, guests). `many`
  is a hard limit (§4).

Whether the recipients are **known** (people the person has corresponded with) is NOT part
of the kind. It's a check on each call (§4): an approval of a send to a new person still
says the agent's draft was right, but no autonomous call ever reaches a new person.

The label people see is templated from the three parts ("Booking confirmations by text, to
one person", "Calendar invites, to a few people").

**Outcomes recorded** (one row per settled card or autonomous action, idempotent on
source and outcome):

| Outcome | From | Counts as |
|---|---|---|
| `approved` | the card's Accept, input unchanged | clean: +1 to the streak |
| `approved_edited` | Accept with the person's edit (flow steps today), with `edit_ratio` | ratio ≤ 0.05: neutral; above: breaks the streak |
| `dismissed` | the card's Dismiss (denied) | breaks the streak; within 14 days it blocks any offer |
| `expired` / `failed` | the card lapsed / a re-check refused it | neutral (nobody judged the work) |
| `ran` | an autonomous action ran and its undo window passed (phase 3) | clean, at its level |
| `undone` | the person undid an autonomous action (phase 3) | demotes at once |
| `complaint` | the person said "don't do that" about one (phase 3) | demotes at once |

`edit_ratio` is the word-level edit distance between the stored input's text and the edit's
text, divided by the longer one's length (0 = unchanged, 1 = rewritten). It's computed over
the string values of the canonical input, capped at 4,000 words a side. Past the cap it
reads as 1, which is the safe side.

The record is **per person** (the approver: `tool_approval.user_id`) **and per
workspace**. Only the owner of a held call can approve it (`caller.ts mayApprove`), so
only their yeses count, and a teammate's record never moves another person's kind.

## 2. Graduation rules

Three levels: **ask** (a card, today) → **tell** (do it, tell me, with undo) → **quiet** (do
it, put it in the daily digest).

The rules are one pure function over the kind's latest outcomes and the person's decisions
(`evaluateKind`, `src/lib/autonomy/rules.ts`). It's tested on every threshold. The constants
and their reasoning:

| Constant | Value | Why |
|---|---|---|
| `TELL_STREAK` | 10 clean approvals in a row | With 0 rejections in 10, the rule of succession puts the next one's chance of rejection at about 1 in 12. At the tell level the person still sees each one and can undo it, so the bar is "almost always right", not "never wrong". It's also the number the issue's own sentence uses. |
| `TELL_MIN_DAYS` | the streak spans ≥ 7 days | One afternoon's batch of 10 identical cards says little about next week. A week covers the person's normal rhythm. |
| `TELL_MIN_DISTINCT_DAYS` | on ≥ 3 different days | Same reason: 9 on Monday and 1 on Sunday isn't a habit. |
| `QUIET_STREAK` | 20 clean autonomous runs at tell, none undone | Two windows' worth more, after the person has watched it work unattended. By the rule of three, 0 undos in 30 runs (10 + 20) bounds the undo rate at about 10% with 95% confidence. |
| `QUIET_MIN_DAYS` | ≥ 14 days at tell | Two weeks of seeing each one before it goes quiet. |
| `RECENT_CLEAN_DAYS` | no dismissal, undo or complaint in the last 14 days (30 for quiet) | A recent no means the person's standard moved. |
| `TRIVIAL_EDIT_RATIO` | 0.05 | A fixed typo or a changed sign-off shouldn't reset 9 good ones. A real rewrite should. |
| `DEMOTION_COOLDOWN_DAYS` | 14 | After a demotion, no offer for two weeks, even if a new streak builds. |
| `OFFER_DECLINED_COOLDOWN_DAYS` | 30 | "Not now" means no new ask for a month. "Never" pins the kind to ask until the person changes it in Settings. |
| `MAX_AUTONOMOUS_PER_KIND_PER_DAY` | 20 | Even a graduated kind cards the 21st call of the day: a loop gone wrong is capped. |
| `MAX_AUTONOMOUS_PER_PERSON_PER_DAY` | 50 | The same cap across all of one person's kinds. |

**Demotion:** a single `undone` or `complaint` puts the kind back to **ask** at once, from
tell or from quiet, never one step down. The streak starts again from zero, and the cooldown
starts. A `dismissed` card at the ask level resets the streak (it's a no on that kind). The
agent never promotes and never un-demotes; the person's yes is the only way up (§3).

## 3. The person's consent to graduate

Nothing graduates silently. When `evaluateKind` says a kind is **eligible**, the agent
proposes it once, in the person's home thread, with a templated card:

> "I've drafted 10 booking confirmations by text over the last 9 days, and you sent every
> one unchanged. Want me to just send these and tell you each time, with an undo?"
> **Yes, do these** · Not now · Never

- The card's words and numbers come from the record, by code, not from a model.
- Only the person's own click answers it (the same person-only rule as an approval card,
  `mayApprove`). The model can't accept it: `settle_card` and `accept_proposal` refuse it.
- **Yes** writes the grant for that one kind (`level = 'tell'`, with when, from which
  card, and the record at that moment). **Not now** sets the 30-day cooldown. **Never**
  pins the kind.
- Quiet is offered the same way, separately, once its own rules hold.

## 4. Hard limits that never graduate

There are two layers, and both are deterministic code (`src/lib/autonomy/hard-limits.ts`):

**(a) An allowlist of kinds that can graduate at all.** A tool is graduatable only if it's
named in `GRADUATABLE_TOOLS` (or, for a connected app's tool, the app marks it as neither
destructive nor open-world, and its name passes the deny patterns below). A new tool that
ships without a decision can't graduate. That's fail-closed, the same reason the reviewer
reviews an unclassified tool. The first list: `book_quote` (confirming a booked time),
`create_calendar_event` / `update_calendar_event`, `offer_times` / `nudge_time_offer`
(email or text), and `push_action_to_linear` / `_jira` / `_asana`.

**(b) Never, whatever the record says:**

- **Spending money or payments:** `send_payment_link`, the Studio's paid generations
  (`generate_studio_*`), anything Stripe, and connected-app tools named like
  pay/charge/refund/invoice/purchase/order.
- **Deleting:** every tool the registry classes `delete` (`delete_calendar_event`,
  `cancel_booking`, `discard_email_draft`, …), and connected-app tools that are destructive
  or named like delete/remove/trash/archive/cancel.
- **Anything to a NEW recipient,** checked on every call, not on the kind. Every address
  the call reaches must be one the person has corresponded with: a message from them, or
  sent to them, in the person's own mail index, or a workspace member, or a CRM contact the person added by hand (Liam, 11-27). Teammates count as
  known; they're people too, so they're still a send (Liam, 10-26). A recipient that can't
  be checked (a lookup that fails, an address that can't be parsed) is new. Fail closed.
- **Legal or contract commitments:** `send_quote` (a price is an offer someone can accept),
  `accept_time_offer` on the person's behalf, and connected-app tools named like
  sign/contract/agreement/envelope.
- **Mass sends:** `launch_campaign`, `launch_sequence`, `enroll_contacts_in_sequence`,
  `publish_prospect_list`, `post_team_chat_poll`, and any call whose audience is `many`
  (more than `MASS_SEND_CAP` = 3).
- **Changing permissions or sharing:** `connect`, `disconnect`, and connected-app tools
  named like share/permission/invite/grant/role/access/member.
- **Irreversible by the trust policy and the outward gate:** `unsubscribe_thread` ("can't be
  taken back"), `publish_post` / `schedule_post` (public), `open_browser` /
  `run_browser_task` (open-ended), `answer_guest`, and `ask_agent`.

`isHardLimited(kind)` and `callHitsHardLimit(call)` are separate functions, each with its
own test that runs every listed tool through the whole graduation path with a perfect
record and asserts it stays at ask.

### Migration 354, and how this differs

354 (Liam, 10-17: "opinionated platform, no configuration fatigue") removed the Trust page,
its write API and every stored `trust_policy` override, so every workspace resolves
`DEFAULT_TRUST_POLICY` with `allow_external: false`: external actions always wait for a
person. This shallow clone has no history from before 354, so its own header and
`trust-policy.ts`'s comments are the record of why.

How this design differs:

1. **No knobs.** Nobody sets thresholds, confidence floors or per-entity rules. The numbers
   are code constants. The only things a person does are answer one yes/no offer per kind,
   and press revoke. That isn't configuration; it's the same one-click shape as Always allow.
2. **`trust_policy` and `allow_external` are untouched.** The extraction path (proposals
   applied by confidence) keeps its defaults. Earned autonomy never reads them or writes
   them, and never restores the Trust page. It works in the outward gate's policy
   (`decideAction`), per person and per kind.
3. **It's evidence plus the person's yes, not confidence.** 354's `allow_external` was a
   workspace-wide "fire external actions on model confidence". This is narrower: one kind,
   one person, after a record they can see, with an undo and an automatic demotion.

**The conflict, said plainly:** Liam, 10-26: "nothing reaches another person without the
person's final yes" (the outward gate's calendar rule, `ACT_ON_YOUR_OWN_GUIDANCE`). A
graduated kind does reach another person without a yes on *that* call. The proposal is that
the per-kind grant is the person's standing yes, as Always allow already is for a connected
app, and that the undo window (§5) keeps a last yes-or-no on every send at the tell level.
**This needs the owner's decision** (decision 1). Until then, no grant changes what
`decideAction` returns.

## 5. Undo windows and the audit trail

Every autonomous action is a row in `autonomy_action` (phase 3's migration). It holds the
kind, the stored input and its hash (what runs is what was recorded, as with approvals),
the level it ran at, the status (`scheduled` → `ran` | `cancelled` | `failed`, then maybe
`undone`), and its undo.

- **Before it runs, an undo window.** A call that reaches a person is scheduled
  `UNDO_WINDOW_MINUTES` (5) ahead, not run at once. At tell, the person gets a home-thread
  line: "I'm sending Dana the booking confirmation for Thu 2 PM in 5 minutes.
  **Undo**". Undo before it runs cancels it: nothing was sent, and the outcome is `undone`,
  which demotes. At quiet there's no ping, but the same window and the same Undo sit in
  "What I did on my own today". A call that reaches nobody (a push to Linear) runs at once.
- **After it runs, undo where the tool allows it**, by a compensating call the code knows
  (`UNDO_OF`): a created calendar event is deleted (as the person's click, so a delete stays
  the person's), a pushed Linear issue is archived, an offer of times is withdrawn
  (`withdraw_time_offer`). A text or email that went can't be unsent: its row says so, and
  Undo isn't offered after its window.
- **"What I did on my own today":** a section in Settings › Autonomy and a block in the
  daily digest. It lists each autonomous action, its kind, who it reached, when, and its
  Undo while one applies.
- The kill switch (`agent_autonomy.mode = 'off'`), a revoke of the kind, or the person
  leaving the workspace cancels every `scheduled` row before it runs. The executor re-checks
  all three, the hard limits and the input hash at run time, as `approveToolCall` re-checks
  an approval.

## 6. Settings › Autonomy

There's a new section, **"What the agent has earned"**. Each kind gets a row: its label, its
level (Ask, Tell me, Quietly), its record ("14 sent unchanged, 1 edited, 0 dismissed, last
on Nov 24"), what it still needs ("3 more over 2 more days"), and a **Revoke** button that
puts it back to Ask. A hard-limited kind shows "Always asks" and why. The global kill
switch stays where it is, above everything.

Phase 1 ships it read-only, behind the setting: the record and "Always asks", no buttons.

## 7. Recurring work

A loop's flow-step outward call already asks `decideAction(..., { flowStep: true })` and
parks on the owner's card. With a grant, the same call for a graduated kind, passing every
per-call limit and cap, becomes an `autonomy_action` instead of a card. The step waits out
the undo window, then carries on with the call's output, as it does after an Accept. A
loop whose every outward step is a graduated kind therefore runs end to end without asking.
A loop with one ungraduated step still parks on that one step's card.

- The kind is the same across doors: the person's yeses on a loop's cards build the same
  record as their yeses in chat, because it's the same tool, channel and audience.
- The reviewer still runs. For a graduated call made unattended, a reviewer "no" (or a
  review that can't run) falls back to the card, never to a run and never to a deny.
- Other unattended callers (work runs, the live agent, relays) keep `deny`. Their ceilings
  hold no outward tools anyway.
- The loop's own runs list shows "ran on its own (Tell me)" on such a step.

## 8. The data model

**Migration 725** (phase 1; additive, its own begin/commit, applied WITHOUT
`--single-transaction`):

- `autonomy_outcome`: `id`, `workspace_id`, `user_id`, `kind_key`, `tool`, `channel`,
  `audience`, `source` (`tool_approval` | `autonomy_action`), `source_id`, `outcome`,
  `edit_ratio` (numeric, null unless edited), `created_at`, and
  `unique (source, source_id, outcome)`. RLS: the person reads their own rows. Only the
  service role writes.
- `autonomy_kind`: one row per person × workspace × kind for the person's decisions:
  `level` (`ask` | `tell` | `quiet`, default `ask`), `pinned_ask`, `granted_at`,
  `granted_card_id`, `demoted_at`, `offered_at`, `offer_declined_at`, `updated_at`. In
  phase 1 nothing writes it, because there are no offers yet. RLS: the person reads their own.
  Writes go only through the person's own routes (service role, after `mayApprove`).

**Migration 726** (phase 3): `autonomy_action`, as in §5.

**The setting:** `EARNED_AUTONOMY` in `web/.env.example` and `deploy/app/.env.example`. It's
off by default and in check_settings.py's "may be empty" list:

- empty: off. Nothing is recorded or shown, as today.
- `record`: outcomes are recorded, and the Settings list shows them read-only (phase 1).
- `graduate`: offers and autonomous runs (phase 3 on, after the owner's decisions).

The workspace kill switch outranks it.

## Phases

| Phase | What | Lets an outward action run without a card? |
|---|---|---|
| 0 | This plan | no |
| 1 | `AGENT_AUTO_ATTEMPT_ENABLED` doc and check fixed. Migration 725. Outcomes recorded at `approveToolCall` / `denyToolCall` / expiry, behind `EARNED_AUTONOMY=record`. The pure rules and hard limits, with tests. The read-only Settings list. | no |
| 2 | Offers (the home-thread card, Yes / Not now / Never) and Revoke. The grant is stored and shown, and has no effect yet. | no |
| 3 | Migration 726. `decideAction` answers `run` for a granted kind under `EARNED_AUTONOMY=graduate`. The undo window, the executor with run-time re-checks, compensating undos, demotion on undo. "What I did on my own today". | **yes**, after the owner's decisions |
| 4 | Recurring work: flow steps on the same path, the digest block, the loop's run line, quiet offers. | yes |
| 5 | Internal kinds: suggested actions from meetings (`proposed_change`) and Mail's drafts, recorded the same way. | internal only |

## What's built (phases 1 to 3)

Where the build differs from the sections above, this list is what the code does.

- **The record** (phase 1, migration 725). It's written at `approveToolCall`,
  `denyToolCall` and the expiry sweep (`src/lib/autonomy/record.ts`).
- **The offer** (phase 2, `offers.ts`) is one templated line in the home thread, written by
  code from the record and linking to Settings › Autonomy. It is not a card with buttons.
  The yes is the person's own click there (`POST /api/account/autonomy/earned`, `decide.ts`):
  Hand it over, Not now, Always ask, Allow offers again, Take it back. The server re-reads
  the record and the hard limits, so a client can't hand over a kind that hasn't earned it.
  The model has no way to reach the route.
- **Running on its own** (phase 3, migration 726, `graduate.ts`, `actions.ts`, `undo.ts`).
  When the outward gate holds a call that the trust authority already answers `ask` with,
  and `graduationFor` says yes, the call is still raised as the person's card. The card is
  worded "goes on its own in 5 minutes. Dismiss it to stop it". An `autonomy_action` row
  is written and an Inngest event (`autonomy/action.scheduled`) sleeps to the end of the
  window.
  - At run time `graduationFor` checks everything again: the switch, the kill switch, the
    grant, a demotion, the day's caps, and whether each recipient is known.
  - Then the card's own accept path (`approveToolCall`) runs, as the person, on their
    standing yes. It re-checks membership, the input hash and the ceiling.
  - Any no sends it back to the card, with a line in the home thread.
  - The card's Dismiss in the window is the Undo. It writes `undone`, and the kind goes
    back to ask with the 14-day cooldown.
  - The Stop button in "What I did on my own today" is that same Dismiss.
  - A hold the authority denies (an unattended loop outside a flow step, a work run)
    never reaches `graduationFor`. A guest's call or a Mac job's always asks.
- **Known recipients** (`known.ts`). Mail history means mail the person **sent** (Sent, or
  Gmail's SENT label). A thread flagged suspicious or as an injection doesn't count.
  Mail only received doesn't count, because an injected email would otherwise make its own
  sender known. Hand-added contacts are `source = 'manual'`, created by the person's own
  member, not merged, and without the HubSpot hold that an unattended agent's contact
  carries. A quote's customer and a poll's guests are known only when every address and
  number they're reached at is known.
- **Quiet** is behind `EARNED_AUTONOMY_QUIET`, off. While it's off, nothing is offered quiet
  and a stored quiet reads as tell.
- **Not yet** (phase 4):
  - compensating undos after a call ran (a sent message can't be unsent; its window was
    its undo);
  - the daily digest block;
  - loop `call_tool` steps on connected apps. They hold through their own path
    (`flows/call-tool.ts`), and connected-app tools can't graduate yet anyway: the door
    has no destructive hint, so they fail closed.

## Decisions (Liam, 11-27)

1. **Standing yes.** The person's yes to "handle this kind yourself" counts as their final
   yes for outward kinds, with the 5-minute undo window before each send. Revoke stays
   available at any time. This amends the 10-26 rule ("nothing reaches another person
   without the person's final yes"): both are cited in `caller.ts` and the gate.
2. **Ceiling at launch is tell.** Quiet is built behind its own switch,
   `EARNED_AUTONOMY_QUIET`, which stays off. Nothing offers or promotes to quiet while it's
   off, and a stored quiet reads as tell.
3. **Known recipient** is any of: mail history; workspace members; CRM contacts the person
   added by hand. Contacts that came in through a bulk import (CSV, vCard, export files,
   the Stripe/HubSpot/Brevo/Google imports) do NOT count, told apart by the contact's
   source. A contact whose source can't be read counts as new.
4. **Thresholds as proposed:** 10 clean in a row over 7 or more days on 3 or more distinct
   days; no dismissal, undo or complaint in 14 days; caps of 20 per kind and 50 per person
   per day; a 5-minute undo window; one undo or complaint drops the kind back to ask with a
   14-day cooldown.
5. **The first graduatable list** as proposed (§4a). The allowlist and the never-list were
   approved for the code: new tools can't graduate by default, and a recipient whose lookup
   fails counts as new.

Migration numbers were assigned by the managing session because three branches build in
parallel: 725 (phase 1) and 726 (phase 3).
