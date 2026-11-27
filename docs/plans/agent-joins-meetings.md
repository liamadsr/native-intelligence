# Your agent joins a meeting for you

Status: phase 1 built on `claude/agent-joins-meetings`, behind `MEETING_AGENT` (off). Roadmap
issue #12. The owner said "let's do it" (Liam, 11-27). Nothing is merged or rolled out, and
nothing has been tried against a real meeting or phone number. Migration: 723. The code is in
`web/src/lib/meeting-agent/` (its files name the sections below); the chat tool is
`send_agent_to_meeting` (`web/src/lib/ai/tools/meeting-agent.ts`); the routes are
`/api/account/meeting-agent` and `/api/calls/meeting/status`, plus the meeting branch of
`/api/calls/live`.

Built differently from the first draft of this plan, in phase 1: the capture is written when
the call ends (no pending capture at send time), and a "check with you" ask is urgent for
15 minutes (the router waits 2 minutes before it routes anything).

Phase 2 built on the same branch, also behind `MEETING_AGENT`, migration 727:
- The person's answer to a "check with you" ask is read out in the meeting as theirs ("<Name> says: …"), while the call is up (`reply-relay.ts`). The ask tells them it will be read out.
- Recurring opt-in: `meeting_attendance_series`. The person approves a brief once with `every_occurrence`, and a sweep every 30 minutes sends each occurrence a day and a half ahead. "Skip this one" cancels that occurrence and it stays skipped. A series can be paused or stopped (`series.ts`).
- Settings › Meetings: status, asks, cancel / skip / pull out, and the series with pause and stop. The nav item shows only while the setting is on.
- NOT done: moving the bridge out of the web request. The worker is the same Next server, and an hour-long Inngest step needs checks on real infrastructure first, so it stays an owner and infrastructure item. The brief editor is still the chat card (no form in the meeting prep card yet).

The goal: "Your agent joins a meeting on your behalf, speaks for you, takes the notes, and texts
you if it needs you."

## 0. What exists today (checked on origin/main, bcff8857)

- **Capture has no bots, by design.** The live agent (`web/src/lib/live-agent/*`, and
  `tell_note_taker`) only advises the person who is recording ("Advise; never act on their
  behalf"). This feature is the first time the product acts in a meeting for someone, so it is
  a new mode with its own consent rules (§2), not a change to the live agent.
- **Our own team calls** (LiveKit, `deploy/livekit`) have a hidden, listen-only recorder
  (`recorder/`). It feeds the capture feed (`web/src/lib/capture-feed/contract.ts`: start,
  roster, segments, heartbeat, end). The feed was designed for "a producer that joins
  someone's Meet, Teams or Zoom call", but its start function (588) only knows `team_call`.
- **Phone calls with the owner's agent.** OpenAI GPT-Live over our Twilio SIP trunk:
  `POST /api/calls/live` (the webhook), `src/lib/calls/{caller,live-api,live-bridge,live-session,call-turn-server}.ts`.
  Calls are **inbound only**: Twilio sends a call to OpenAI's SIP address, OpenAI posts
  `live.transport.incoming` to us, we accept it, and the bridge attaches to the sideband. Each
  hand-off runs a full turn in the caller's home thread, **as the owner**. Calls stop after
  `CALL_MAX_MS` (10 min), because the bridge runs inside the webhook request (`after()`).
- **Reaching the owner.** `src/lib/reach/route.ts`: a message written to the home thread with
  `reach/route.requested` finds the person (app banner, push, text, Slack). It waits while
  they are busy in a meeting, unless the message is urgent (`metadata.urgent_by`), and it
  respects quiet hours.
- **Meetings** are not rows. Google and Microsoft are read live
  (`src/lib/integrations/calendar.ts`). Per-meeting state is keyed by calendar event id and
  start, as `meeting_goal` (356) does. Google gives `conferenceData.entryPoints`, which
  includes `phone` entries with a `pin`. Microsoft gives `onlineMeeting`, but we do not read
  its dial-in. Zoom puts its dial-in in the description text.
- **Our cloud browser runtime** (the sandbox server) runs one headless browser per person and
  workspace. It is built for the person's own sign-ins, not for joining meetings.

## 1. How the agent gets into the meeting

| | (a) Dial in by phone | (b) Headless browser as a guest | (c) Meeting-bot API (e.g. Recall.ai) | (d) Native participant in our LiveKit calls |
|---|---|---|---|---|
| Works for | Zoom, Meet, Teams, Webex: any meeting with a dial-in number. Many Meet and Teams meetings have none (it depends on the host's licence), and Zoom's needs the host's audio plan | Meet, Teams and Zoom web clients, as long as guests may join | Zoom, Meet, Teams, Webex and more | Our own team calls only |
| Audio in | 8 kHz phone audio: everyone mixed into one stream, so no per-speaker tracks | The page's mixed audio, with some speaker names from the page | Separate tracks per speaker, with names | One track per participant, with names (as the recorder already gets) |
| Audio out | GPT-Live speaks on the line | Our TTS fed into a fake microphone in the browser | Their output-media API (we stream audio to them) | A published audio track |
| Shows as | A phone number ("+1 555-0100", or "Call-in user"). **The name can't be set**, so the spoken announcement (§2) carries the identity. Zoom lets the host rename it | Any name we type, e.g. "Liam's assistant (AI)" | Any name, e.g. "Liam's assistant (AI)" | "Liam's assistant (AI)", our own UI |
| Reliability | High: phone bridges are old and stable. Risks: DTMF timing on the PIN, waiting rooms (the host must admit the caller), "press 1 to join" prompts | Low: UI changes, waiting rooms, "ask to join", sign-in walls, CAPTCHAs and bot detection. Running it is an ongoing maintenance job | High: it's their whole business. They handle waiting rooms and give clear status events | High: our own server and our own code |
| Cost (check current prices) | Twilio outbound about $0.014/min (US) plus its SIP leg, plus GPT-Live's per-minute audio. The same rate as today's calls | Our sandbox server's CPU (one browser plus media per meeting) plus TTS and STT | About $0.50 to $1 per bot hour plus transcription, on top of our own model costs | GPT-Live's minutes. LiveKit is ours |
| From the owner | Nothing new: the Twilio number, OpenAI project and trunk secret we already have. One new setting (OpenAI's SIP address for outbound legs) and Twilio's voice URL. US/CA numbers only at first (our Twilio geo permissions) | Nothing new for accounts. A decision on running unattended guest clients on our sandbox server | **A new paid vendor**: an account, a key, a DPA, and data leaving to a third party. That is a decision only the owner can make | `livekit-sip` running in `deploy/livekit` (a new container; a change to the server's stack) |
| Provider terms | Dialling into a meeting's published dial-in as a participant is normal phone use. We announce ourselves and our recording (§2) | Grey area. Automating Meet's and Teams' web clients is not a supported integration, and Zoom wants its Meeting SDK for bots | Supported: Recall uses each platform's sanctioned routes (Zoom's Meeting SDK, which needs a Zoom app review, and Teams/Meet guest join). We'd sign their terms | Ours |
| Build time | About 1 to 2 weeks for a first version (most of the stack exists) | 3 to 5 weeks, plus upkeep forever | About 1 to 2 weeks once the account exists | About 1 week once `livekit-sip` runs (it dials the same OpenAI SIP address into the room) |

**Recommended order: (a), then (d), then (c). Not (b).**

1. **(a) first.** It reuses the most: the Twilio account, the OpenAI project, the trunk secret,
   the webhook, the accept and the bridge. It works on every platform that has a dial-in, and
   it needs no new vendor. The new piece is an **outbound** leg: Twilio's REST API calls the
   meeting's number and, once it answers, plays its PIN as DTMF (`SendDigits`). TwiML then
   bridges that call to OpenAI's SIP address with our trunk header and a one-time meeting
   token. OpenAI posts `live.transport.incoming` to our webhook as usual, and the token tells
   us which meeting this is (§6).
2. **(d) second.** In our own calls, the same GPT-Live session joins the room as a named SIP
   participant through LiveKit's SIP service (an outbound trunk to OpenAI's SIP address). The
   audio stack is the same as (a). The notes and live agent we already have keep working (the
   recorder hears everyone's microphone, and now the assistant's too). The manager's prior was
   (d) first. I put it second only because it needs a change to the server's stack
   (`livekit-sip`), while (a) needs none.
3. **(c) for meetings without a dial-in**, if the owner wants that coverage. It is the
   sanctioned, reliable route, and it shows a proper name. It needs a new vendor (an owner
   decision), so it is not built until the owner says yes.
4. **(b) not at all**, unless (c) is refused and the coverage still matters. It is fragile, its
   terms are unclear, and it needs constant upkeep.

## 2. Identity and consent (non-negotiable)

These rules are written into the session instructions and the code, and each has its own test:

- **Never pretends to be the person.** It is introduced as "<Name>'s assistant (AI)". In the
  instructions, a fixed sentence forbids speaking as <Name>, or saying "I" for <Name>'s
  opinions or commitments.
- **It announces itself near the start.** The bridge sends the opening words itself (a
  commentary append), so they don't depend on the model choosing to say them: "Hi, I'm
  <Name>'s AI assistant. I'm attending for <Name>, who can't be here, and I'm taking notes
  for them. If anyone would rather I didn't, say so and I'll leave." On a dial-in, the
  announcement is the only identity people get (the line shows a number), so it goes first,
  before anything else is said. A late joiner can ask "who's that?", and it answers the same.
- **No voice cloning.** It speaks in one fixed stock voice (`CALL_VOICE`). Nothing takes a
  voice sample from the person, and there's no setting for one.
- **Recording consent.** It announces, and on any objection it leaves. Objection phrases in
  the transcript ("please don't record", "I don't consent", "can the bot leave") are caught
  two ways: the instructions tell GPT-Live to hand off and say goodbye, and the backend
  matches the phrases itself as a fence. Either way the call is hung up and the notes stop.
  What was heard before the objection is kept only as the owner's private notes, marked as
  ended on objection. Whether even that should be dropped is an owner decision (§7). It joins
  only US/CA numbers at first. Two-party-consent states are covered by the announcement and
  the leave-on-objection rule.
- **Explicit opt-in, per meeting.** Nothing joins on its own. The person sends it to one
  meeting with an approved brief (§3). Sending it is a confirmation card (or the
  brief editor's "Send"), never an inference. A recurring opt-in is phase 2: one approval
  covers a series, every occurrence is listed in the app, and a "skip this one" is one tap.
- It never joins a meeting the person isn't invited to (the event must be in their calendar),
  and it never joins one that has already ended.

## 3. What it may say

- **The brief** is the approved fence: `goals`, `facts it may share`, `questions to ask`, and
  `must not agree to`. Each is a short list (at most 10 items of 300 characters). The person
  approves it, and its `approved_at` is stamped. A brief changed after approval needs
  approving again.
- **It talks only when it's addressed or when its goals call for it.** The instructions tell
  it to stay quiet otherwise. It never commits to money, dates, deadlines, prices or decisions
  beyond the brief: "I can't agree to that for <Name>. I'll check with them."
- **Hand-offs don't run as the owner.** This is the big difference from today's calls. On a
  phone call, the caller is the owner. In a meeting, the person talking is *someone else*. So
  a meeting hand-off **never** runs a home turn, never touches the owner's tools, and never
  reads their workspace. It runs one `utility` task (`runUtilityTask`, on eve, no tools). That
  task's input is the brief and the question, and its output is exactly one of:
  `answer` (from the brief only), `check_with_owner` (with a one-line question for the person),
  or `quiet`. That keeps every model call on eve, with no new provider. It also means meeting
  guests can't steer the owner's agent (no prompt injection into a tool-holding turn).
- **"I'll check with <Name>."** On `check_with_owner`, it says so in the meeting. It writes one
  message to the owner's home thread (metadata `meeting_attendance_id`, `urgent_by` = now +
  2 min, so the router doesn't wait out "busy in a meeting"), and sends
  `reach/route.requested`. The owner gets it by text, push or Slack, whichever they're on. **Their reply relayed back live** is phase 2:
  the bridge watches the home thread for the owner's answer (their next user message after
  the ask, from any channel), checks it against "must not agree to", and passes it on: "<Name>
  says: …". In phase 1 the reply lands in the thread, and the notes record that the question
  was open.

## 4. Notes

- When the person sends the agent, a pending **capture** is made for the meeting and linked
  to its `calendar_event_id`, as the calendar-capture tool does today.
- The bridge keeps every transcript fragment: the meeting's (one mixed speaker, labelled
  "Meeting") and the assistant's own (labelled "<Name>'s assistant (AI)"). When the call ends,
  the transcript is written to the capture, and the normal finishing pass runs: summary,
  action items, decisions, CRM links. The notes look like any meeting's.
- Phase 3 (with (d)) and later (with (c)) feed the notes live through the capture feed, as a
  new source kind. That's a 588 change, so it doesn't happen in phase 1.
- Phone audio means no speaker names. The summary attributes by content where it can, and
  says it can't otherwise. (c) and (d) give real names.

## 5. Product surface

- **From chat:** "go to my 3pm for me". The new chat tool `send_agent_to_meeting` resolves the
  meeting, finds its dial-in, and drafts a brief from the meeting prep (goal from
  `meeting_goal`, open items, what not to commit to). It stops at a confirmation card that
  shows the brief and "Send my assistant". The card is the opt-in. Editing goes through chat
  ("don't agree to any dates") or the brief editor.
- **From the meeting:** a "Send my assistant" action on the meeting prep card and on the
  calendar event. It opens the brief editor (phase 2 UI): four short lists, the dial-in it
  found (editable, or "add a dial-in"), and Send.
- **Live status:** one status row per attendance (scheduled, dialling, waiting to be let in,
  in the meeting, left, failed, left on objection), with the latest "check with you" asks.
  The meeting card and the home thread show it, using the existing card styles. A "Pull my
  assistant out" button hangs up.
- **Afterwards:** the capture appears as any meeting's does, and the home thread gets one
  message: "I attended <title> for you. Notes are here, and two things need you."

## 6. The data model

**Migration 723 (`723_meeting_attendance.sql`)**: additive. It has its own `begin`/`commit` (so
it is applied WITHOUT `--single-transaction`), has a lock timeout, and is safe to re-run.

`meeting_attendance`: one row per meeting the agent is sent to.
- `workspace_id`, `user_id` (the person it attends for), `calendar_event_id`, `starts_at`,
  `ends_at`, `title`. One row per person per meeting (unique on workspace, user, event, start),
  following 356.
- `status`: `draft`, `scheduled`, `dialling`, `in_meeting`, `ended`, `cancelled`, `failed` or
  `objected`. Plus `status_detail` (a short code) and `status_at`.
- `join_method` (`dial_in`; `livekit`, `bot_api` later). `dial_in_number` (E.164) and
  `dial_in_pin` (DTMF digits, `#`, `*` and `w`). Both are private to the person, like the rest
  of the row.
- The brief: `brief jsonb` (`goals`, `may_share`, `ask`, `must_not_agree`, each `text[]` as
  JSON) and `brief_approved_at`.
- `display_name` (what it calls itself: "<Name>'s assistant (AI)"), `owner_first_name`.
- `capture_id` (on delete set null), `live_session_id` (GPT-Live's), `twilio_call_sid`.
- `join_token_hash`: the sha256 of the one-time token the outbound leg carries in
  `X-NI-Meeting`. The webhook matches the hash, never the token. It is cleared once the call is
  accepted, so a replay can't join twice.
- `asks jsonb`: the "check with you" questions, with times and the home message id.
- `announced_at`, `objected_at`, `joined_at`, `left_at`, `created_at`, `updated_at`.
- RLS: owner-only select, insert, update and delete, with `is_workspace_member` (the 356
  pattern). The server runs on the service role, fenced on the person.

**Phase 2: `meeting_attendance_series`** (a recurring opt-in): workspace, user, series id
(Google's `recurringEventId`, Microsoft's `seriesMasterId`), a default brief, `paused_at`.

**New settings** (each gets a line in `deploy/app/.env.example`; empty means off):
- `MEETING_AGENT`: `on` lets people send the agent to meetings (the tool, the API, the dial).
  Needs the calls settings (`GPT_LIVE_*`, `TWILIO_*`). Off by default.
- `MEETING_AGENT_SIP_URI`: OpenAI's SIP address for the project
  (`sip:<project id>@sip.api.openai.com;transport=tls`), which the outbound leg dials. It is
  the same address the trunk sends inbound calls to. Empty means no dial.
- `MEETING_AGENT_MAX_MINUTES`: the cap on one attendance (default 30, at most 90). The bridge
  still runs in the web process (`after()`), so a roll-out of the web container cuts a meeting
  in progress. Moving the bridge into a long-lived process (the worker, or its own container
  like the recorder) is phase 2, and it is needed before meetings are long or frequent.

## 7. Risks, and what can't be tested without the owner

- **GPT-Live in a room full of people.** It was built for one caller. Whether it can be kept
  quiet except when addressed, through instructions alone, is the biggest unknown (the
  calling spike notes that "a prompt is the only control we have"). Phase 1's first real test
  is a meeting between the owner and a colleague: does it interrupt? Does it talk over
  people? If it can't be kept quiet, the fallback is listen-only (notes plus "check with",
  where it only speaks the announcement, its asks and answers to direct questions), which the
  backend can enforce by never appending commentary except those.
- **The PIN and DTMF timing** differ for each platform (Zoom: meeting ID `#`, then `#` for
  participant, then passcode `#`. Meet: PIN `#`. Teams: conference ID `#`). These are tested
  in unit tests against mocks only. Real joins need real meetings.
- **Waiting rooms.** The host must admit a phone caller. The status shows "waiting to be let
  in", and after 10 minutes it gives up.
- **Meetings that run long** are cut at `MEETING_AGENT_MAX_MINUTES`, or by a roll-out (above).
- **Consent law.** The announcement plus leave-on-objection is the design. Whether to keep the
  notes from before an objection, and whether to allow numbers outside US/CA, are owner and
  legal calls.
- **Cost.** Each minute in a meeting is a GPT-Live minute plus Twilio's. The cap and the
  per-meeting opt-in bound it. No usage metering per person exists yet for calls.
- **The owner must test (nothing here can be tested from this container):** the outbound
  Twilio leg to a real meeting number, the TwiML bridge to OpenAI's SIP address carrying
  `X-NI-Meeting`, the webhook seeing that header in `sip_headers`, the announcement being
  heard, an objection hanging up, the "check with you" text arriving, and the capture filling
  in.

## 8. Phases

1. **Phase 1, dial-in (a), behind `MEETING_AGENT`.** Migration 723. The brief and its checks.
   The dial-in parser (Google entry points, Teams' `onlineMeeting`, and Zoom/Meet/Teams text
   in the description). The meeting session's instructions and announcement. The objection
   fence. The outbound dial (Twilio REST plus TwiML to OpenAI SIP with the meeting token). The
   webhook's meeting branch. The meeting bridge (hand-offs as brief-only utility tasks,
   "check with" asks to the owner through the reach router, the transcript to the capture at
   the end). The schedule (an Inngest function sleeps until a minute before the start, then
   dials). The `send_agent_to_meeting` chat tool with its confirmation card, and the
   attendance API (send, cancel, status, pull out). Tests for each piece, with every provider
   mocked.
2. **Phase 2.** The owner's reply relayed live into the meeting. The brief editor and live
   status in the meeting prep and calendar cards. Recurring opt-in
   (`meeting_attendance_series`). The bridge moved out of the web request into a long-lived
   process.
3. **Phase 3, (d) our LiveKit calls.** `livekit-sip` in `deploy/livekit` with an outbound
   trunk to OpenAI's SIP address. The assistant joins as a named participant, and notes come
   from the recorder as today.
4. **Phase 4 (only on the owner's yes to a vendor): (c) a meeting-bot API** for meetings
   without a dial-in. It gets per-speaker notes through the capture feed as a new source kind
   (a 588 change).

**Owner decisions needed:**
- Phase 1 needs no new account. Before any real test, it needs `MEETING_AGENT_SIP_URI` and
  `MEETING_AGENT=on` in the server's `.env`, migration 723 applied, and a roll-out.
- (d) needs `livekit-sip` on the server.
- (c) needs a new vendor (Recall.ai or similar): an account, a key, a DPA.
- What happens to notes from before an objection: keep them, private (the default as built),
  or drop them.
- Whether to allow non-US/CA dial-ins.

## 9. Proposal: moving the call out of the web request (not built; for the owner)

**Today.** OpenAI's webhook (`POST /api/calls/live`) reaches `web`, as every route but
`/api/inngest` does (`deploy/app/proxy/Caddyfile`). The route accepts the call, and the
bridge then holds the call's sideband WebSocket inside that process, in `after()`, for
the whole meeting. `next start` ignores the route's `maxDuration` (800 s), so the cap is
only `MEETING_AGENT_MAX_MINUTES` and Twilio's `TimeLimit`. A roll-out replaces `web` by
starting a new container, then `docker stop -t 120` on the old one (`deploy/app/deploy.sh`,
`roll web 120`). A meeting is therefore cut 120 s after any roll-out begins replacing
`web`, and a crash or the daily reboot cuts it at once. The same is already true of
phone calls, which are capped at 10 minutes.

Two facts constrain every option:
- The sideband socket lives in one process's memory. We have not verified whether
  GPT-Live lets a second attach pick up a session once the first socket closes. If it
  does not, no option can move a live call from one process to another, and a
  roll-out can only wait for the call to end.
- `deploy.sh`'s `roll` waits for `docker stop -t <grace>` before moving on. Any grace
  long enough for a meeting makes that roll-out step wait as long.

### Option A: a dedicated long-lived service in deploy/app's compose (recommended)

The bridge moves out of Next into its own small Node process, `meeting-bridge`, much
like `recorder/`.
- The webhook only accepts the call (it must answer OpenAI within seconds) and marks
  the attendance "needs a bridge".
- The service claims each such attendance through a database lease (one bridge per
  call, renewed every few seconds) and attaches.
- It writes the notes and asks through the app's internal routes (a shared secret, as
  the recorder's capture feed does), or through the service-role database. The
  meeting turn's model call stays on eve, through the app.

**On the server:**
- A new service in `deploy/app/compose.yaml`, with `stop_grace_period` set to the cap
  plus a margin (about 95 min at `MEETING_AGENT_MAX_MINUTES=90`).
- A new secret in `deploy/app/.env`, `MEETING_BRIDGE_SECRET`.
- A small migration: the lease columns on `meeting_attendance`.

**Timeouts:**
- The webhook's accept answers in under 10 s, as now.
- The lease is renewed every 5 s and lost after 30 s.
- The service has no request timeout: it makes outbound WebSocket and HTTPS calls only.

**How a roll-out stops cutting meetings:** `deploy.sh` treats `meeting-bridge`
differently from `web`, which is a change to the deploy tooling.
1. It starts the new container.
2. It sends the old one SIGTERM without waiting: `docker stop` in the background, or a
   "drain" signal.
3. The old container stops claiming new calls and exits once its last call ends (at
   most the cap).
4. New calls go to the new container from the start.

The roll-out itself finishes in minutes; only the old container lives on until its
calls end.

**What the owner must do:**
- Approve the new service, its secret and the migration.
- Approve the `deploy.sh` change. It touches `deploy/app`, so automatic deploys would
  hold it.
- Roll it out by hand once.

**Cost:** about a week to build and test, with the recorder's pattern to follow. It
also brings the phone calls' 10-minute cap within reach of lifting.

### Option B: the worker, with a longer stop grace (quickest interim)

Send `/api/calls/live` to `worker` instead of `web` (one line in the Caddyfile), and
raise the worker's `stop_grace_period` and `deploy.sh`'s `roll worker` grace to the
cap plus a margin (about 95 min). The bridge code does not change: it still runs in
`after()`, in the worker.

**On the server:**
- One `route` in `proxy/Caddyfile`.
- `stop_grace_period` in `compose.yaml`.
- The number in `deploy.sh`.
- The proxy restarts once (a second or two).

**Timeouts:**
- Inngest's steps (600 s) still finish within the grace.
- `docker stop -t` becomes about 5700 s.

**How a roll-out stops cutting meetings:** the old worker keeps running its calls
until they end, inside its grace, while the new worker takes new calls and Inngest.
The cost is that a roll-out started during a meeting now takes up to the meeting's
remaining length, because `roll worker` waits for the old container to stop. Web and
cron are replaced only after that.

**What the owner must do:**
- Approve the three edits in `deploy/app`. Automatic deploys hold them.
- Accept that roll-outs can take as long as a meeting.
- Avoid rolling out during meetings, or roll out knowing it will wait.

**Cost:** a day, plus a test that the worker answers OpenAI's webhook (its health
check and its routes are the same server).

### Option C: an Inngest step (not recommended)

The webhook accepts the call and sends an event. An Inngest function's step attaches
and runs the bridge.

**On the server:**
- Nothing changes in compose.
- The self-hosted Inngest's step timeout and the worker's grace must cover a meeting.
  Steps are capped at 600 s today, so a 30 to 90 minute call does not fit in one step.

**Timeouts:**
- A single step can last at most 600 s unless Inngest's limit is raised.
- Chaining 9-minute steps needs the re-attach above: each step would re-attach to the
  same session, with the transcript, open asks and relay state saved between steps.
- A retried step would attach again in the middle of a meeting.

**How a roll-out stops cutting meetings:** only if re-attach works. Each step ends
within the worker's 900 s grace, and the next step lands on the new worker. Without
re-attach, this is Option B with extra moving parts.

**What the owner must do:**
- Confirm with OpenAI that GPT-Live sessions can be re-attached.
- Possibly raise Inngest's limits on the server.

**Cost:** the most code (state saved between steps) and the most unknowns.

### Recommendation

1. Option B first, if meetings need to survive roll-outs soon: it is a day's work, and
   its one cost (slow roll-outs during meetings) is visible and controllable.
2. Then Option A as the lasting answer, which also lets phone calls run longer.
3. Option C only if OpenAI confirms re-attach and a long-lived service is unwanted.

Whichever is chosen, this question should be asked of OpenAI first: can a GPT-Live
session's sideband be re-attached after its socket closes? The answer decides
whether a crash, a reboot or a roll-out can ever be survived mid-meeting, or only
waited out.
