# GitHub Reviews and pull-request automation

One place to see and act on a person's GitHub pull requests, and actions that move on
their own as their pull requests move. Built to match the behaviour Macro describes in its
public docs (macro.com/github: a "Reviews" view, and status sync from pull requests). Clean
room: only Macro's public product pages were read for behaviour; none of its code,
wording, CSS or icons. Everything here is written from scratch.

Branch `claude/github-reviews`. Reserved migrations 694 and 695.

## What exists today (research)

- **GitHub sign-in is an OAuth App, not a GitHub App.** `src/lib/oauth/config.ts`: scopes
  `repo` and `read:user`. The token sits encrypted in `user_oauth_tokens` (provider and
  capability `github`), readable only by the service role (migration 466), through
  `storedGithubToken` (`src/lib/oauth/github-token.ts`). Settings: `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`. The person's GitHub login is not stored
  anywhere usable (the connection's display email falls back to `<login>@github`).
- **Webhook** `src/app/api/webhooks/github/route.ts`: one shared HMAC secret; a webhook is
  added by hand per repository (`deploy/app/README.md`). It handles `pull_request`
  (opened/edited link by identifier in the title and body; closed/reopened/synchronize
  sync state; ready_for_review) and `check_suite`/`check_run` (the coding agent's CI fix
  loop). Opened/closed/reopened fire `pr_status_changed` loops
  (`src/lib/flows/emit-pr-status-change.ts`) for authors who are OWNER/MEMBER/COLLABORATOR.
- **Links**: `action_github_pr` (migration 064): action, repo, number, title, state, draft,
  checks_status, head_branch. Written by the webhook, `POST /api/account/actions/[id]/prs`,
  the MCP tools `ni_link_pr` / `ni_get_pr_status` / `ni_list_linked_prs`
  (`src/lib/mcp/tools/github.ts`) and the Mac's pull requests. Shown in the action panel's
  "Pull requests" row (`views/action-detail-panel.tsx`), live through realtime (283).
- **Status moves already exist** for our own agents' runs (`src/lib/actions/agent-finish.ts`):
  `beginStateFor` (first started state, only from a not-started category), `reviewStateFor`
  (a started state whose name reads "review", else the first started state, never
  backwards), `doneStateFor`, `movedByHandSince` (a person's hand move wins),
  `linkedPullRequestsHold` (another open linked PR holds the card), and
  `completeActionsForMergedPr`. Workflow categories (migration 020) are backlog, unstarted,
  started, completed, canceled: there is no review category.
- **Visibility**: actions are seen through their team (`actions_select` joins `team`, whose
  policy hides a private team from people not on it; `src/lib/views/visibility-fence.ts`
  restates it for service-role reads). `action_github_pr`'s own RLS is workspace-wide (a
  pre-existing gap: it does not follow private teams); every new read below goes through
  the action, so it follows the team.
- **Pages**: the rail's entries are `/` pages (`src/lib/chat-cards/page-menu.ts`,
  `pages.ts`, `page-server.ts`, `components/chat-cards/pages/*`, `rail/rail-pages.ts`,
  `rail/page-groups.ts`, `rail/rail-icons.ts`). Go-tos are `GO_TO` in `src/lib/shortcuts.ts`.
- **Notifications**: `notification` (recipient is a member id), `createNotification`
  (`src/lib/notifications.ts`), type and target-type CHECKs last redone in 688.

## Phase 1: the Reviews page (no migration)

A new `/` page and rail entry, **Reviews** (kind `reviews`, gated with My Actions' view
`todo`, members only).

**Data.** Read live from GitHub with the person's own token, never stored:
`GET /api/account/github/reviews` runs one GraphQL `search(type: ISSUE)` for the section,
with qualifiers built server-side from validated filters:

| Section | Qualifier |
|---|---|
| Review requests | `review-requested:@me` |
| Authored by me | `author:@me` |
| Assigned to me | `assignee:@me` |
| Involves me | `involves:@me` |

State filter Open / Closed / All (`is:open`, `is:closed`, nothing). Filters: repo, author,
assignee, label, review state (`review:none|required|approved|changes_requested`), sort
(`sort:updated-desc`, `sort:created-desc`). "Linked work" (linked / not linked) is applied
after the search, against `action_github_pr` joined to actions the person can see. Each row
carries title, number, repo, author, draft, state, merged, `mergeable`, `mergeStateStatus`,
`reviewDecision`, the head commit's `statusCheckRollup.state`, labels, assignees, additions /
deletions / changed files, updated and created times, and `viewerCanUpdate` and the repo's
`viewerPermission`. 50 per page with a cursor ("Load more"). Filter values are checked
(`owner/name`, GitHub login, label text) before they reach the query: nothing the person
types becomes a qualifier of its own.

**List and Board.** The board's columns are derived, in this order (first match wins):
Merged (merged) → Draft (open, draft) → Conflicts (`mergeable = CONFLICTING`) → Checks
failing (rollup FAILURE or ERROR) → Ready to merge (approved, rollup SUCCESS or no checks,
`mergeStateStatus` CLEAN or HAS_HOOKS) → In review (every other open one). A closed,
unmerged pull request has no column (a note under the board counts them; the list shows
them). Pure function, unit-tested.

**Side panel** (`GET /api/account/github/reviews/[owner]/[repo]/[number]`): the description
(markdown, through the app's existing sanitized renderer), its checks (name, conclusion,
link), its linked actions (only those the person can see; click opens the action), the
files changed (REST `pulls/{n}/files`, up to 100 files) with a read-only unified diff drawn
by our own small renderer from the `patch` field (no new dependency), and "Open on GitHub"
for approving and commenting, which stay on GitHub.

**Merge.** `POST /api/account/github/reviews/[owner]/[repo]/[number]/merge`. The button
shows only when the pull request is open, not draft, approved or not requiring review,
checks passing, `mergeStateStatus` CLEAN/HAS_HOOKS, and the person's `viewerPermission` is
WRITE, MAINTAIN or ADMIN. It always opens a confirm dialog (method chosen among the
repository's allowed ones: merge, squash, rebase). The server re-reads the pull request
with the person's token, refuses unless every condition still holds, and merges with the
head sha it showed the person (`sha`), so a push in between makes GitHub refuse it. GitHub
remains the final judge (branch protection, required reviews). No agent tool merges in this
phase.

**Keys.** G then V is taken by Studio, and every other letter but G is taken (the registry
test refuses a clash). Proposal: **G G** for Reviews ("GitHub"), Studio keeps G V. See
Decisions. In the list, J/K/Enter work as in every list (it reuses the list keyboard).

## Phase 2: status from pull requests (migration 694)

**Linking.** The webhook already links by identifier in a PR's title and body. Added: the
head branch name (identifiers there are lower case, e.g. `eng-42-fix-login`, matched
case-insensitively against the workspace's team prefixes), and a new `create` event (a
branch pushed): a branch naming an action is remembered in `action_github_branch` until a
pull request from it arrives.

**Who it moves for (the fence).** An action moves only when the branch's pusher or the
PR's author is a member of the action's workspace with their GitHub account connected
(the new `github_identity` row ties GitHub's numeric user id to our user), their
`author_association` is OWNER, MEMBER or COLLABORATOR, and the action's team has the switch
on. A stranger's PR on a public repository that names ENG-42 links (as today) but moves
nothing. This also fixes, for moves, the existing webhook's habit of matching ENG-42 in
every workspace that has any GitHub connection.

**Moves** (onto each team's own states, reusing agent-finish.ts's pure functions):

| Event | Move | Rule |
|---|---|---|
| branch created naming it | → in progress | `beginStateFor`: first started state, only from Backlog/Todo categories |
| PR opened or ready for review (not draft) | → in review | `reviewStateFor`: a started state named like "review"; **a team with none: the first started state** (so it is at least In Progress); never backwards from a later started state |
| PR merged | → done | `doneStateFor`, once no other open linked PR holds it (`linkedPullRequestsHold`) |
| PR closed unmerged | → back | to the state it was in before the automation first moved it for this PR or branch (`status_before_id`), only if it still sits where the automation put it and no other open linked PR holds it |

Never touches an action in a completed or canceled state (a person closed it), and never
one a person moved by hand since the automation last moved it (`movedByHandSince`). Each
write is guarded on the status it read. The activity log has three actors (member,
agent, system); a webhook move is the **system**'s, as other webhook writes are. The flow dispatcher hears it as a `status_changed` with an automation
origin (depth 1), so loops opted in to automated changes still fire.

**The switch.** `team.github_automation` (boolean, default true) in the team's settings
page: "Move actions when their pull requests move". Writable by whoever may edit the team
today (owners, admins, team leads). Off: links still form, nothing moves.

**⇧⌘B** on a selected action (a row the keyboard is on, or the open panel) copies a branch
name: `<identifier lowercased>-<title slug>`, at most 60 characters (`eng-42-fix-login-bug`),
with a toast. Registered in the shortcuts registry (scope `task`). Also a "Copy branch name"
item in the action's menu.

**On the action.** The panel's pull request rows show title, `#number`, `+adds −dels`, and
state (open, draft, merged, closed), from new columns on `action_github_pr` the webhook
fills (`additions`, `deletions`, `changed_files`, `author_github_id`).

### Migration 694 (`694_github_reviews.sql`, its own `begin; … commit;`)

- `github_identity` (user_id, github_user_id bigint, login, updated_at; unique per
  github_user_id): filled on connect (`complete-connect.ts`) and refreshed when the person
  opens Reviews (we call GitHub's `/user` with their token anyway). RLS on: a person reads
  their own row; no client insert/update/delete (service role only).
- `action_github_branch` (workspace_id, action_id, repo_full_name, branch,
  status_before_id, created_at; unique per action, repo, branch). RLS on: select follows the
  action's visibility (`exists (select 1 from actions a where a.id = action_id)`, which runs
  the actions/team policies); no client writes.
- `action_github_pr` + `additions`, `deletions`, `changed_files`, `author_github_id`,
  `status_before_id`, `auto_moved_at`. A client-update guard in the 359/369/675 style keeps
  `status_before_id`, `auto_moved_at` and `author_github_id` server-only (the existing
  member update policy stays for title/state, which the app writes on a manual link).
- `team.github_automation boolean not null default true`.
- Parses with `psql` on a local Postgres with the baseline; rehearsed there with several
  users (a private team's action invisible to a non-member through the new tables).

## Phase 3: GitHub notices in the inbox (migration 695)

New notification types `github_review_requested`, `github_pr_comment` and
`github_checks_failed`, and target type `github_pr` (target_id empty; `metadata.pr_url`,
repo, number, and the linked action ids the recipient can see). Clicking opens the Reviews
page's panel on that pull request.

| GitHub event | Who hears it |
|---|---|
| `pull_request.review_requested` | the requested reviewer (a user; a team request reaches nobody, as GitHub team membership isn't read) |
| `issue_comment.created` on a PR, `pull_request_review.submitted` (with a body, or changes requested), `pull_request_review_comment.created` | the PR's author, and every `@login` mentioned in the text |
| `check_suite.completed` failure, on a PR's head | the PR's author (once per head sha) |

A GitHub user becomes a recipient only through `github_identity`; never the commenter
themself. One notice per person, in the workspace where the pull request is linked to an
action they can see, else the workspace of their newest GitHub connection. Text is short
and templated ("Dana requested your review on acme/app#12"), with the first 140 characters
of a comment in the body. 695 also adds `github_pull_request` (repo, number,
author_github_id, head_sha; RLS on, no policies: service role only), filled from
`pull_request` events, so a check-suite failure can find its author without a token.

## What the owner must change on GitHub

No change to the OAuth App's scopes: `repo` already covers search, reading pull requests,
files and checks, and merging. On **each repository's webhook** (Settings › Webhooks, the
one pointing at `/api/webhooks/github`), under "Let me select individual events", also
tick:

- **Branch or tag creation** (`create`) — phase 2's "branch created → in progress";
- **Issue comments** (`issue_comment`) — phase 3;
- **Pull request reviews** (`pull_request_review`) — phase 3;
- **Pull request review comments** (`pull_request_review_comment`) — phase 3.

Already needed and presumably ticked: Pull requests, Check suites, Check runs. An
organization that restricts third-party OAuth apps must approve the app for Reviews to see
its repositories (GitHub's own setting). Each person reconnects GitHub once after phase 2
rolls out only if their `github_identity` row is missing; opening Reviews fills it too.

## New dependencies

None planned (GraphQL through `fetch`; the diff renderer is our own).

## Decisions to review

1. **Go-to key.** G V is Studio's; every other letter but G is taken. Proposal: Reviews
   gets **G G**, Studio keeps G V. Alternative: Reviews takes G V and Studio moves to G G.
2. **Automation default.** On for every team (as Macro does), with the per-team switch to
   turn it off. Alternative: off until a team turns it on.
3. **A team with no review state.** "In review" moves the action to the team's first
   started state (In Progress) and no further; we don't create a state for them.
4. **Closed without merging.** Back to the state before the automation's first move for
   that PR (or its branch), only if no person moved it since.
5. **Fence.** Moves only for PRs/branches by a workspace member with GitHub connected and
   repo association OWNER/MEMBER/COLLABORATOR. Linking stays as today.
6. **Board column for closed, unmerged PRs**: none (counted under the board, listed in List).
7. **⇧⌘B** is Chrome's "show bookmarks bar"; inside the app we take it (preventDefault) while
   an action is selected. Alternative: ⌘⇧. as Linear.
8. **No agent tool merges.** Reviews' merge is a person's button only. A read-only agent
   tool (list my review requests) could follow later, through the existing tool policy.
9. **Notice workspace**: the one where the PR is linked to an action the recipient sees,
   else their newest GitHub connection's.
10. **Pre-existing gaps, left as they are** (out of scope, flagged): `action_github_pr`'s RLS
    is workspace-wide rather than following private teams; the webhook links an identifier
    in every workspace that has a GitHub connection.

## Status

- Phase 1: in progress (no migration).
- Phases 2 and 3: waiting on the managing session's OK for migrations 694 and 695.
