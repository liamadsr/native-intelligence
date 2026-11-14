/**
 * Unattended Mac jobs (L5, docs/plans/teammate-agent.md; local-agents.md §8
 * and §9 decision 8): a loop's step (a flow's run_local_agent action, fired by
 * its trigger or its schedule) starts a job on the person's Mac with nobody
 * watching. A chat starts one only from a typed turn (start_local_agent,
 * src/lib/chat/local-agent-tools.ts); this is the one other way in, and it
 * calls store.ts's public functions only.
 *
 * The rules, each enforced here or by what this hands the doors:
 *   - only in a folder the person shared: a live grant in their own
 *     environment (listFolders), and edits only where the Mac allows them;
 *     the job names the folder's id, never a path (invariant 2);
 *   - only while the reviewer blocks the Mac (the default and 'blocking',
 *     src/lib/safety/review-mode.ts): a start is refused while
 *     ACTION_REVIEW_MODE says shadow, and every tool call the job makes goes
 *     through it with `mustEnforce`, checked against the loop step's SAVED
 *     request (unattendedToolReview), never against the rendered text, whose
 *     trigger values may be outside text;
 *   - never while the workspace's agent is paused, failing CLOSED (a settings
 *     read that fails counts as paused: nobody is there to notice a wrong yes);
 *   - the switch and the pause reach running jobs too: while either holds,
 *     every tool call of a loop's job is refused and the job asked to stop
 *     (unattendedToolReview);
 *   - only on a Mac that is online now: a request queued for whenever it
 *     wakes would start hours later with nobody expecting it;
 *   - one agent per folder, store.ts's rule (createSession, WS-C): this
 *     loop step's live job takes the fire's request as its next turn; an idle
 *     session there (nothing open, queued, pending or still pushing) ends to
 *     make room; another loop's job, the person's busy one or a job being
 *     stopped makes the fire skip (`FOLDER_BUSY`). A loop never joins the
 *     person's job or another loop's (its calls would be reviewed against
 *     the wrong words). A retried fire gets back the job it started or the
 *     live one that took it; when the one that took it has ended since, the
 *     fire is skipped (`ALREADY_SENT`), its request not run a second time;
 *   - a short queue: a job no Mac claims within 15 minutes expires;
 *   - it reports like any other job: its conversation is the person's home
 *     thread, so each turn's ledger row reports there (ledger.ts, origin
 *     'chat'), and the main chat sees it in local_agents;
 *   - the person can see and stop it: it is an ordinary session, listed in
 *     the Mac's tray and the Agents panel, stopped from either (or by
 *     stop_local_agent), with the Mac's off switch above all of it.
 *
 * How a session is known to be unattended: its idempotency key, which only
 * startUnattendedLocalAgent writes (`local-agent-loop:<flow>:step:<action>:
 * fire:<fire>`). The server writes it; nothing model-visible does. A session
 * without that prefix is someone's typed or clicked start.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ACTION_JOB_KEY_PREFIX,
  FOLDER_HOLDING_STATUSES,
  LOCAL_AGENT_REQUEST_MAX_BYTES,
  LocalAgentError,
  MAC_FULL_CODE,
  QUEUED_TTL_MS,
  SESSION_SELECT,
  TERMINAL_STATUSES,
  UNATTENDED_KEY_PREFIX,
  addMessage,
  createSession,
  isUuid,
  listFolders,
  listSessions,
  loadSession,
  reapIfStale,
  requestStop,
  turnStillOpen,
  type DbSession,
  type LocalAgentMode,
  type LocalAgentStatus,
  type SessionRow,
} from './store'
import { actionReviewMode, type ActionReviewMode } from '@/lib/safety/review-mode'
import { localAgentLoopInstructions } from '@/lib/safety/loop-instructions'
import type { CallerClass } from '@/lib/safety/caller'
import { AGENT_PAUSED_CODE, AGENT_PAUSED_REASON, checkAgentPaused } from '@/lib/work/agent-paused'
import { ensureHomeThread } from '@/lib/chat/home-thread'

type Svc = SupabaseClient

/** The idempotency-key prefixes that mark a session a loop, or an action's Start, put on the Mac (store.ts owns them). */
export { ACTION_JOB_KEY_PREFIX, UNATTENDED_KEY_PREFIX }

/** Which loop step and fire started a job. */
export interface UnattendedOrigin {
  flowId: string
  actionId: string
  /** One per fire (the flow run, or the trigger event): a retried fire reuses its job. */
  fireKey: string
}

/** A key part: no colon, so the key reads back unambiguously (the chat keys' rule). */
const KEY_PART_RE = /^[^:\s]{1,200}$/

/** The key a loop-started session carries. Throws on a malformed part (a caller bug, never a person's input). */
export function unattendedIdempotencyKey(origin: UnattendedOrigin): string {
  for (const part of [origin.flowId, origin.actionId, origin.fireKey]) {
    if (typeof part !== 'string' || !KEY_PART_RE.test(part)) throw new Error('An unattended job needs a flow, a step and a fire id')
  }
  return `${UNATTENDED_KEY_PREFIX}${origin.flowId}:step:${origin.actionId}:fire:${origin.fireKey}`
}

const KEY_RE = /^local-agent-loop:([^:\s]{1,200}):step:([^:\s]{1,200}):fire:([^:\s]{1,200})$/

/** The loop step behind a session's key, or null when no loop started it. */
export function parseUnattendedKey(key: string | null | undefined): UnattendedOrigin | null {
  if (typeof key !== 'string' || !key.startsWith(UNATTENDED_KEY_PREFIX)) return null
  const m = KEY_RE.exec(key)
  return m ? { flowId: m[1], actionId: m[2], fireKey: m[3] } : null
}

/**
 * A Mac job a person's Start on an action put on their own Mac (environments
 * E2, plan §3): the project's work runs there because they switched "Run my
 * work here" on. Unattended, like a loop's job: the click is the only
 * evidence of what they want, and the action's title and description come
 * from teammates, meetings and emails. One `startId` per press, so a new
 * Start is a new job.
 */
export interface ActionJobOrigin {
  actionId: string
  startId: string
}

/** The key an action-started session carries. Throws on a malformed part (a caller bug). */
export function actionJobKey(origin: ActionJobOrigin): string {
  if (!isUuid(origin.actionId) || typeof origin.startId !== 'string' || !KEY_PART_RE.test(origin.startId)) {
    throw new Error('An action job needs an action and a start id')
  }
  return `${ACTION_JOB_KEY_PREFIX}${origin.actionId}:start:${origin.startId}`
}

const ACTION_KEY_RE = /^local-agent-action:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):start:([^:\s]{1,200})$/i

/** The action behind a session's key, or null when no action's Start made it. */
export function parseActionJobKey(key: string | null | undefined): ActionJobOrigin | null {
  if (typeof key !== 'string' || !key.startsWith(ACTION_JOB_KEY_PREFIX)) return null
  const m = ACTION_KEY_RE.exec(key)
  return m ? { actionId: m[1].toLowerCase(), startId: m[2] } : null
}

/** Whether a session a loop, or an action's Start, put on the Mac (its key, as loadSession returns the row). */
export function isUnattendedSession(row: { idempotency_key?: string | null } | null | undefined): boolean {
  return parseUnattendedKey(row?.idempotency_key) !== null || parseActionJobKey(row?.idempotency_key) !== null
}

export interface StartUnattendedInput {
  /** The loop's owner: the job runs on THEIR Mac, in THEIR folder, never anyone else's. */
  userId: string
  workspaceId: string
  folderId: string
  /** The request in words (the step's template, rendered with its values fenced). */
  request: string
  mode?: LocalAgentMode
  origin: UnattendedOrigin
}

export type UnattendedRefusalCode =
  | 'REVIEWER_NOT_BLOCKING'
  | typeof AGENT_PAUSED_CODE
  | 'FOLDER_NOT_SHARED'
  | 'EDITS_NOT_ALLOWED'
  | 'NO_HOME_THREAD'
  | 'BAD_REQUEST'

export type StartUnattendedResult =
  | { status: 'started'; session: SessionRow; created: boolean; deviceOnline: boolean; joined?: true }
  | { status: 'skipped'; code: 'FOLDER_BUSY' | 'MAC_OFFLINE' | 'ALREADY_SENT' | 'MAC_FULL'; reason: string; sessionId: string | null }
  | { status: 'refused'; code: UnattendedRefusalCode; reason: string }

export interface UnattendedDeps {
  /** The reviewer's mode (the kill switch); injectable for tests. */
  reviewerMode?: () => ActionReviewMode
  /** The workspace's agent switch, failing closed; injectable for tests. */
  paused?: (svc: Svc, workspaceId: string) => Promise<boolean>
  /** The person's home thread id; injectable for tests. */
  homeThread?: (svc: Svc, userId: string, workspaceId: string) => Promise<string>
}

/** The workspace's agent switch for a Mac job: a read that fails counts as paused. */
function pausedFailClosed(svc: Svc, workspaceId: string): Promise<boolean> {
  return checkAgentPaused(svc, workspaceId, 'flow_step', { failClosed: true })
}

async function homeThreadId(svc: Svc, userId: string, workspaceId: string): Promise<string> {
  return (await ensureHomeThread(svc, { userId, workspaceId })).id
}

/** How long a loop's job waits for the Mac to claim it (a person's waits 6 hours). */
export const UNATTENDED_QUEUED_TTL_MS = 15 * 60_000

/** The request's first words: a loop's job, said so (never the loop's name: any member of the workspace can change it). */
const LOOP_PREFIX = '[From one of your loops]'
/** …and an action's Start (never the action's title here: it is fenced inside the request). */
export const ACTION_REQUEST_PREFIX = '[From one of your actions]'
const ACTION_PREFIX = ACTION_REQUEST_PREFIX

/** "[From one of your loops] <request>", clipped to the Mac's byte cap on a character boundary. */
export function unattendedRequestText(request: string, prefix: string = LOOP_PREFIX): string {
  const text = `${prefix} ${request.trim()}`
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= LOCAL_AGENT_REQUEST_MAX_BYTES) return text
  const note = '…[cut to fit]'
  let out = ''
  let bytes = encoder.encode(note).length
  for (const ch of text) {
    const n = encoder.encode(ch).length
    if (bytes + n > LOCAL_AGENT_REQUEST_MAX_BYTES) break
    out += ch
    bytes += n
  }
  return `${out}${note}`
}

/** What a refusal or a skip says, by who asked: a loop's step, or an action's Start. */
interface StartWords {
  shadow: string
  notShared: string
  noHome: string
  offline: (mac: string, folder: string) => string
  busy: (where: string) => string
}

const LOOP_WORDS: StartWords = {
  shadow: "Native Intelligence's safety reviewer is switched to log-only on this server, so loops can't start Mac jobs until it blocks again",
  notShared: "That folder isn't shared on the loop owner's Mac any more (or never was theirs)",
  noHome: 'The loop owner has no home thread for the job to report in',
  offline: (mac, folder) => `${mac} is offline, so this fire started no job in ${folder}`,
  busy: (where) => `Native Intelligence is already working in ${where}, so this fire started none`,
}

const ACTION_WORDS: StartWords = {
  shadow: "Native Intelligence's safety reviewer is switched to log-only on this server, so an action can't start on your Mac until it blocks again.",
  notShared: "That folder isn't shared on your Mac any more.",
  noHome: 'You have no home thread for the job to report in.',
  offline: (mac, folder) => `${mac} is offline, so nothing started in ${folder}. Open Native Intelligence on it and press Start again, or turn off “Run my work here” for this project to run it in the cloud.`,
  busy: (where) => `Native Intelligence is already working in ${where}. Wait for it to finish, or stop it, then press Start again.`,
}

/** A work card's Start in a folder it picked: the same, but its way out is another place on the card. */
const CARD_WORDS: StartWords = {
  ...ACTION_WORDS,
  shadow: "Native Intelligence's safety reviewer is switched to log-only on this server, so work can't start on your Mac until it blocks again.",
  offline: (mac, folder) => `${mac} is offline, so nothing started in ${folder}. Open Native Intelligence on it and press Start again, or pick another place for this work.`,
}

/**
 * Start a job on the loop owner's Mac. Never throws for a refusal: a rule it
 * breaks comes back as `refused` (or `skipped` while the step's last job is
 * still live), with the reason the run's history shows. A retried fire (the
 * same origin) returns the job it already started, or the live one that took
 * its request as a turn (`created: false`); one whose request went into a job
 * that has ended since is skipped (`ALREADY_SENT`), not run again.
 */
export async function startUnattendedLocalAgent(
  svc: Svc,
  input: StartUnattendedInput,
  deps: UnattendedDeps = {},
): Promise<StartUnattendedResult> {
  let key: string
  try {
    key = unattendedIdempotencyKey(input.origin)
  } catch (err) {
    return { status: 'refused', code: 'BAD_REQUEST', reason: err instanceof Error ? err.message : 'invalid loop step' }
  }
  if (typeof input.request !== 'string' || !input.request.trim()) {
    return { status: 'refused', code: 'BAD_REQUEST', reason: 'The step has no request to hand to the Mac' }
  }
  return startUnattended(svc, { ...input, key, text: unattendedRequestText(input.request), words: LOOP_WORDS, retriedFire: true }, deps)
}

/**
 * The agent a person's OWN click chose for an action's Start (migration 658),
 * always explicit: a coding agent's id, or null for Native Intelligence's
 * own agent (what the action panel's "with" control showed them). Only the
 * start-agent route passes it, and only when the request named one: a
 * person's own agent runs its own shell and file tools, which our risky-call
 * reviewer never sees, so only a person may start it. Every other start (a
 * request without a choice, loops, automations, work cards settled for
 * them) runs on Native Intelligence's own agent.
 */
export interface PersonAgentChoice {
  worker: string | null
}

export interface StartActionMacJobInput {
  /** Who pressed Start: the job runs on THEIR Mac, in THEIR folder, never anyone else's. */
  userId: string
  workspaceId: string
  folderId: string
  /** The request in words, the action's title and description fenced as untrusted (actionJobRequest). */
  request: string
  mode?: LocalAgentMode
  origin: ActionJobOrigin
  /** Where the Start was pressed: an action (its project's "Run my work here", the default) or a work card's picker. */
  from?: 'action' | 'card'
  /** A person's own click only (the start-agent route): who does the work. Absent: Native Intelligence's own agent. */
  agent?: PersonAgentChoice
}

/**
 * Start an action's work on the starter's Mac (environments E2): the same
 * rules as a loop's job (the reviewer blocks, the agent switch fails closed,
 * a shared folder with edits only where the Mac allows them, an online Mac,
 * a 15-minute queue, the home thread), with the action's key, so every tool
 * call the job makes is reviewed as unattended. Never throws for a refusal.
 */
export async function startActionMacJob(
  svc: Svc,
  input: StartActionMacJobInput,
  deps: UnattendedDeps = {},
): Promise<StartUnattendedResult> {
  let key: string
  try {
    key = actionJobKey(input.origin)
  } catch (err) {
    return { status: 'refused', code: 'BAD_REQUEST', reason: err instanceof Error ? err.message : 'invalid action' }
  }
  if (typeof input.request !== 'string' || !input.request.trim()) {
    return { status: 'refused', code: 'BAD_REQUEST', reason: 'The action has no request to hand to the Mac' }
  }
  return startUnattended(
    svc,
    {
      ...input,
      key,
      text: unattendedRequestText(input.request, ACTION_PREFIX),
      words: input.from === 'card' ? CARD_WORDS : ACTION_WORDS,
      retriedFire: false,
      // A card waits its turn for a free slot (its badge says "queued"), as long
      // as a person's job may wait: the Mac had to be online for it to start.
      queuedTtlMs: QUEUED_TTL_MS,
    },
    deps,
  )
}

/** The rules every unattended start passes (see the file header), in order. */
async function startUnattended(
  svc: Svc,
  input: {
    userId: string
    workspaceId: string
    folderId: string
    mode?: LocalAgentMode
    key: string
    text: string
    words: StartWords
    retriedFire: boolean
    /** How long it may wait on the server for the Mac to take it (a loop's: 15 minutes; a card's: QUEUED_TTL_MS). */
    queuedTtlMs?: number
    /** Only from startActionMacJob, only when a person clicked Start. */
    agent?: PersonAgentChoice
  },
  deps: UnattendedDeps,
): Promise<StartUnattendedResult> {
  const refused = (code: UnattendedRefusalCode, reason: string): StartUnattendedResult => ({ status: 'refused', code, reason })
  const { key, words } = input
  const mode: LocalAgentMode = input.mode === 'edit' ? 'edit' : 'read'

  // 1. The reviewer blocks, or nothing starts: a job nobody watches never
  //    runs a risky call on a model's word alone.
  if ((deps.reviewerMode ?? actionReviewMode)() === 'shadow') return refused('REVIEWER_NOT_BLOCKING', words.shadow)
  // 2. The workspace's agent switch, failing closed.
  if (await (deps.paused ?? pausedFailClosed)(svc, input.workspaceId)) return refused(AGENT_PAUSED_CODE, AGENT_PAUSED_REASON)

  // 3. A folder the person shared, on their own Mac, with edits only where the Mac allows them.
  const folder = (await listFolders(svc, input.userId)).find((f) => f.id === input.folderId)
  if (!folder) return refused('FOLDER_NOT_SHARED', words.notShared)
  if (mode === 'edit' && folder.mode !== 'edit') {
    return refused('EDITS_NOT_ALLOWED', `${folder.label || 'That folder'} is read-only on ${folder.deviceName || 'the Mac'}; edits must be allowed there`)
  }
  const where = `${folder.label || 'that folder'} on ${folder.deviceName || 'the Mac'}`
  // A Mac that isn't online now gets no job: a queued request would start
  // hours later, whenever the Mac wakes, with nobody expecting it (S4). The
  // step's next fire tries again; a person presses Start again.
  if (!folder.online) {
    return { status: 'skipped', code: 'MAC_OFFLINE', reason: words.offline(folder.deviceName || 'The Mac', folder.label || 'that folder'), sessionId: null }
  }

  // 4. It reports like any other job: in the person's home thread.
  let conversationId: string
  try {
    conversationId = await (deps.homeThread ?? homeThreadId)(svc, input.userId, input.workspaceId)
  } catch (err) {
    console.warn('[local-agent] unattended start: no home thread', err instanceof Error ? err.message : err)
    return refused('NO_HOME_THREAD', words.noHome)
  }

  // A retried fire whose request already went into a job that has ended
  // since: whether that turn ran is the job's history; the fire never runs it twice.
  if (input.retriedFire) {
    const tookIt = await endedJobThatTookFire(svc, { userId: input.userId, conversationId, folderId: folder.id, key, text: input.text })
    if (tookIt) {
      const ended = tookIt.status === 'cancelled' ? 'been stopped' : tookIt.status === 'failed' ? 'failed' : 'expired'
      return {
        status: 'skipped',
        code: 'ALREADY_SENT',
        reason: `This fire's request already went to this step's job in ${where}, which has since ${ended}, so it isn't run again; the step's next fire starts a new job`,
        sessionId: tookIt.id,
      }
    }
  }

  // 5. One agent per folder is store.ts's (createSession, WS-C, with
  //    migration 419's index closing the race): this loop step's live job
  //    takes the request as its next turn (`joined`, counted as started), an
  //    idle session there ends to make room, and anything else (another
  //    loop's job, the person's busy one, a job being stopped) refuses it.
  //    A retried fire returns its own job (the idempotency key).
  try {
    const started = await createSession(svc, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      folderId: folder.id,
      conversationId,
      request: input.text,
      mode,
      startedBy: 'agent',
      idempotencyKey: key,
      // A short wait for the Mac: one that sleeps just after the online
      // check must not start the job hours later, with nobody expecting it.
      queuedTtlMs: input.queuedTtlMs ?? UNATTENDED_QUEUED_TTL_MS,
      // Who does the work: only a person's click names an agent of theirs.
      ...(input.agent ? { explicitWorker: input.agent.worker } : {}),
    })
    return { status: 'started', session: started.session, created: started.created, deviceOnline: started.deviceOnline, ...(started.joined ? { joined: true as const } : {}) }
  } catch (err) {
    if (!(err instanceof LocalAgentError)) throw err
    // One agent per folder: another loop's job, or the person's, is busy there.
    const details = err.details as { code?: unknown; reason?: unknown; session?: { id?: unknown } } | undefined
    // The Mac already holds as many cards as it takes (migration 659): its own sentence.
    if (err.code === 'conflict' && details?.code === MAC_FULL_CODE) {
      return { status: 'skipped', code: 'MAC_FULL', reason: err.message, sessionId: null }
    }
    if (err.code === 'conflict' && details?.code === 'FOLDER_BUSY') {
      return {
        status: 'skipped',
        code: 'FOLDER_BUSY',
        // A card's Start: the store's sentence, which says who works there (a
        // card by its identifier, a chat, a loop; another agent: both agents).
        // A loop's history keeps its own words.
        reason: details.reason === 'other_worker' || words !== LOOP_WORDS ? err.message : words.busy(where),
        sessionId: typeof details.session?.id === 'string' ? details.session.id : null,
      }
    }
    if (err.code === 'not_found') return refused('FOLDER_NOT_SHARED', words === LOOP_WORDS ? "That folder isn't shared on the loop owner's Mac any more" : words.notShared)
    if (err.code === 'forbidden') return refused('EDITS_NOT_ALLOWED', err.message)
    return refused('BAD_REQUEST', err.message)
  }
}

/** A live job an action's Start put on someone's Mac, in this workspace. */
export interface LiveActionMacJob {
  sessionId: string
  /** The coding agent it runs on (migration 658), or null for Native Intelligence's own agent. */
  worker: string | null
  /** Whose Mac. */
  userId: string
  deviceName: string
  folderLabel: string
  status: LocalAgentStatus
}

/**
 * What makes an action's Mac job hold the action: its own turn is still open
 * (store.ts turnStillOpen): it works (queued, starting, running, interrupted
 * mid-turn), or it waits with something open: a question, a queued turn, a
 * request on its way (a Start that just joined it), a native prompt on the
 * Mac (an edit job's "push?" after `finish`) or a push still running. A job
 * whose turn ended with nothing open (isIdle) doesn't: a Start then joins it
 * as its next turn or starts anew (createSession's folder rules), and a
 * teammate's Start runs where theirs runs.
 */
const holdsAction = turnStillOpen

/**
 * The start id of the person's next Start of this action: their latest job
 * for it and its turn (or `first`). Two presses at the same moment read the
 * same, so they share one key and the second gets the first's job (its
 * session key, or the joined turn's message key) instead of a second turn; a
 * press after that turn opened reads the next. Throws on a database error.
 */
export async function nextActionStartId(svc: Svc, args: { userId: string; actionId: string }): Promise<string> {
  if (!isUuid(args.actionId)) throw new Error('An action job needs an action')
  const { data, error } = await svc
    .from('local_agent_session')
    .select('id, current_turn, created_at')
    .eq('user_id', args.userId)
    .like('idempotency_key', `${ACTION_JOB_KEY_PREFIX}${args.actionId.toLowerCase()}:start:%`)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`action jobs read failed: ${error.message}`)
  const last = ((data ?? []) as Array<{ id: string; current_turn?: number | null }>)[0]
  return last ? `${last.id}.t${last.current_turn ?? 1}` : 'first'
}

/**
 * The action's live Mac job, whoever started it, or null: one live run per
 * action, of any kind (the start-agent route). Only one that is working or
 * asking (holdsAction); a finished one waits idle up to a day and holds
 * nothing. Reaped first, so a stale one doesn't hold the action. Throws on a
 * database error.
 */
export async function liveActionMacJob(svc: Svc, args: { workspaceId: string; actionId: string }): Promise<LiveActionMacJob | null> {
  if (!isUuid(args.actionId)) return null
  const { data, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('workspace_id', args.workspaceId)
    .like('idempotency_key', `${ACTION_JOB_KEY_PREFIX}${args.actionId.toLowerCase()}:start:%`)
    .in('status', [...FOLDER_HOLDING_STATUSES])
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw new Error(`action job read failed: ${error.message}`)
  for (const raw of (data ?? []) as DbSession[]) {
    const r = await reapIfStale(svc, raw)
    if (await holdsAction(svc, r)) {
      return { sessionId: r.id, worker: r.worker ?? null, userId: r.user_id, deviceName: r.device?.name ?? '', folderLabel: r.folder?.label ?? '', status: r.status }
    }
  }
  return null
}

/** The person's own job for an action on their Mac, as the action panel opens it. */
export interface ActionMacJobView {
  sessionId: string
  status: LocalAgentStatus
  /** The coding agent it runs on (migration 658), or null for Native Intelligence's own agent. */
  worker: string | null
  deviceName: string
  folderLabel: string
  /** It still holds the action (working, or asking): what the panel's "working" affordance opens. */
  live: boolean
}

/**
 * The person's own Mac job for this action (their Starts' key,
 * `local-agent-action:<action>:start:…`): the live one when there is one,
 * else the latest. Only their own sessions (a teammate's job on their own
 * Mac is never opened from here). Null when they never started it on a Mac.
 * Throws on a database error.
 */
export async function personActionMacJob(
  svc: Svc,
  args: { userId: string; workspaceId: string; actionId: string },
): Promise<ActionMacJobView | null> {
  if (!isUuid(args.actionId)) return null
  const { data, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('user_id', args.userId)
    .eq('workspace_id', args.workspaceId)
    .like('idempotency_key', `${ACTION_JOB_KEY_PREFIX}${args.actionId.toLowerCase()}:start:%`)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw new Error(`action jobs read failed: ${error.message}`)
  const rows = (data ?? []) as DbSession[]
  if (rows.length === 0) return null
  const view = (raw: DbSession, live: boolean): ActionMacJobView => ({
    sessionId: raw.id,
    status: raw.status,
    worker: raw.worker ?? null,
    deviceName: raw.device?.name ?? '',
    folderLabel: raw.folder?.label ?? '',
    live,
  })
  for (const raw of rows) {
    if (!(FOLDER_HOLDING_STATUSES as readonly string[]).includes(raw.status)) continue
    const r = await reapIfStale(svc, raw)
    if (await holdsAction(svc, r)) return view(r, true)
  }
  return view(rows[0], false)
}

/** How many of the folder's ended loop jobs a fire looks through for its own earlier turn. */
const RETRY_LOOKBACK = 3

/**
 * A fire that joined this step's live job left its request there as a
 * message (store.ts claimFolder, key `start:<key>`), not as a session under
 * its own key. Once that job ends, a retry of the fire would find neither and
 * run the request again in a new job. So a fire first asks the folder's last
 * few ended loop jobs in the home thread for that message, through
 * addMessage: it answers a key it already holds before it looks at the job
 * (`duplicate`), and refuses an ended job before it writes, so asking writes
 * nothing (unattended.test.ts pins that order). A read that fails starts the
 * job as before (every call it makes is still reviewed). Best effort: a job
 * that ends between this look and createSession's, or an idle one being
 * stopped (which claimFolder ends rather than joins), still gets the request
 * again in a new job.
 */
async function endedJobThatTookFire(
  svc: Svc,
  input: { userId: string; conversationId: string; folderId: string; key: string; text: string },
): Promise<SessionRow | null> {
  let ended: SessionRow[]
  try {
    ended = (await listSessions(svc, input.userId, { conversationId: input.conversationId }))
      .filter((s) => s.folderId === input.folderId && !s.attended && (TERMINAL_STATUSES as string[]).includes(s.status))
      .slice(0, RETRY_LOOKBACK)
  } catch (err) {
    console.warn('[local-agent] unattended start: could not read ended jobs', err instanceof Error ? err.message : err)
    return null
  }
  for (const s of ended) {
    try {
      const sent = await addMessage(svc, { userId: input.userId, sessionId: s.id, author: 'agent', text: input.text, policy: 'queue', idempotencyKey: `start:${input.key}`.slice(0, 1000) })
      if (sent.duplicate) return s
    } catch {
      // Ended without this fire's turn.
    }
  }
  return null
}

/**
 * What a tool door applies to a call from an unattended Mac job (the Mac
 * body's /api/local-agent/agent/tool, C1, through agent-seams.ts): the caller
 * class for callerMayCall and the reviewer, the loop step's saved words, and
 * `mustEnforce`. Null for a session a person or a typed chat turn started
 * (that door's own policy applies) and for a session that isn't this
 * person's. A failed read throws: the door must refuse, never fall back to
 * the attended policy.
 *
 * `refused` (S1, S2): the kill switch or the workspace's pause reaches a
 * loop's job already running, not just new starts. While ACTION_REVIEW_MODE
 * says shadow, or the agent is paused (a failed read counts as paused), every
 * call of a loop-started job is refused and the job is asked to stop. The
 * door answers 403 with the reason.
 */
export interface UnattendedToolReview {
  caller: Extract<CallerClass, 'agent_unattended'>
  /**
   * A loop's job: its step's saved request ('loop_instructions'). An
   * action's Start on the Mac: no words at all ('person', none): the click
   * is the only evidence, so the reviewer holds every risky call as the
   * person's card (no_request), and the action's text never speaks for them.
   */
  source: 'loop_instructions' | 'person'
  /** The loop step's saved request and mode, read only when a review runs, and only while the loop is still the job's person's; none for an action's job. */
  personMessages: () => Promise<string[]>
  mustEnforce: true
  /** For the reviewer's usage row: the session. */
  runId: string
  origin: UnattendedOrigin | ActionJobOrigin
}

/** A loop's job the kill switch or the pause reached mid-flight: refused, and asked to stop. */
export interface UnattendedToolRefusal {
  refused: true
  code: 'REVIEWER_NOT_BLOCKING' | typeof AGENT_PAUSED_CODE
  reason: string
}

export async function unattendedToolReview(
  svc: Svc,
  ids: { userId: string; sessionId: string },
  deps: Pick<UnattendedDeps, 'reviewerMode' | 'paused'> = {},
): Promise<UnattendedToolReview | UnattendedToolRefusal | null> {
  const row = await loadSession(svc, ids.userId, ids.sessionId)
  const origin = parseUnattendedKey(row?.idempotency_key)
  const action = origin ? null : parseActionJobKey(row?.idempotency_key)
  if (!row || (!origin && !action)) return null
  const workspaceId = row.workspace_id
  const shadow = (deps.reviewerMode ?? actionReviewMode)() === 'shadow'
  const paused = !shadow && (await (deps.paused ?? pausedFailClosed)(svc, workspaceId))
  const whose = action ? 'an action’s Start put on the Mac' : 'a loop started'
  if (shadow || paused) {
    await requestStop(svc, ids.userId, row.id).catch((e) => console.warn('[local-agent] could not stop an unattended job:', e instanceof Error ? e.message : e))
    return shadow
      ? { refused: true, code: 'REVIEWER_NOT_BLOCKING', reason: `Nothing ran. Native Intelligence's safety reviewer was switched to log-only, so jobs ${whose} are stopped. Finish now; don't retry.` }
      : { refused: true, code: AGENT_PAUSED_CODE, reason: `Nothing ran. ${AGENT_PAUSED_REASON}, so jobs ${whose} are stopped. Finish now; don't retry.` }
  }
  if (action) {
    // No words: the person only pressed Start, and the action's text is the
    // workspace's. Every risky call waits for the person's card.
    return { caller: 'agent_unattended', source: 'person', personMessages: async () => [], mustEnforce: true, runId: row.id, origin: action }
  }
  if (!origin) return null
  return {
    caller: 'agent_unattended',
    source: 'loop_instructions',
    personMessages: () => localAgentLoopInstructions(svc, { workspaceId, flowId: origin.flowId, actionId: origin.actionId, userId: row.user_id }),
    mustEnforce: true,
    runId: row.id,
    origin,
  }
}
