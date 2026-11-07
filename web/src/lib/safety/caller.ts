/**
 * The ONE trust authority (docs/plans/eve-templates-lessons.md F1, F2, F3 and
 * F8; eve-alignment.md §3 and §6 decisions 11 and 14).
 *
 * Who is speaking is decided at intake, from what a door VERIFIED (an
 * HMAC-checked run token, an OAuth row, the person's own app session, a
 * channel's verified sender), never from anything a model wrote. Every door
 * maps its verified principal to one caller class here, and every trust check
 * (the outward gate's hold, the attended-only tools, who may approve a held
 * call, whose run a memory entry is recorded as) reads only that class:
 *
 *   person            the person themselves, in Dial8: the in-app chat, a
 *                     teammate chat or bot conversation with them, a follow-up
 *                     chat turn on a run, their own MCP connector, their own
 *                     click; a Slack DM from their linked Slack user (a
 *                     channel turn, src/lib/slack/turn.ts).
 *   person_remote     the person, verified, away from the app's screen: the
 *                     device ask, and a text from their verified phone (a
 *                     text turn). Later: a call from it. A held call waits as
 *                     a card in their chat (later, on SMS, a bound reply may
 *                     answer it: bindReplyToApproval), but the attended-only
 *                     tools, which act on what is on their screen, stay out.
 *   agent_unattended  nobody is watching: a loop run, a work run's own turns,
 *                     a coding run, the live agent's turns on a meeting, a
 *                     turn the server started, a turn the main agent relayed
 *                     into a bot's thread (its words are the agent's, not the
 *                     person's). A hold is a DENY, never a wait: nobody is
 *                     there to answer it.
 *   other_person      someone else in the workspace talking to this person's
 *                     agent (later: a teammate in a shared Slack channel).
 *                     Asks questions and gets answers from what THEY can see
 *                     (the door runs the read as them: runAsUserFor). Never
 *                     acts, never approves, never writes lasting memory.
 *   guest             a person the owner added (agent_guest, migration 427:
 *                     their partner, a colleague) texting the agent made for
 *                     them, never the owner's main agent. It acts for the
 *                     owner within the tools the owner gave that person
 *                     (the door's ceiling), over the owner's data. Never
 *                     approves, never writes the owner's memory, never holds
 *                     an attended-only or main-chat tool or an outside app's;
 *                     an outward call is always the owner's card, and so is
 *                     whatever the owner said asks first (DecideOptions.guest).
 *   unknown           anything else (an unlinked Slack user, a text from an
 *                     unknown number). No tools at all.
 *
 * The policy is one function, decideAction(class, effect, tool): 'run',
 * 'ask' (the owner's card) or 'deny'. The doors keep their own CEILINGS (what
 * tools a surface holds at all: an edition, a persona, a skill's categories, a
 * work run's classes) and their own reviewer (Jev's action.review); this
 * decides what the caller's class allows within them.
 *
 * Outside channels (decision 14) are app-routed turns: a provider webhook → a
 * Next route that verifies the sender, stamps the class here (channelCaller)
 * and sends a turn into the person's home thread or a conversation. Decision
 * 11: in a group thread the agent replies only when mentioned
 * (channelShouldReply), a teammate's ask is answered from what they can see,
 * and only the owner approves, from their own account (mayApprove).
 *
 * Pure: no I/O, no server-only imports, safe in any runtime.
 */
import { ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, getToolSideEffect, type ToolSideEffect } from '@/lib/ai/tool-registry'
import { GUEST_ONLY_TOOL_NAMES } from '@/lib/guests/tools'

export const CALLER_CLASSES = ['person', 'person_remote', 'agent_unattended', 'other_person', 'guest', 'unknown'] as const
export type CallerClass = (typeof CALLER_CLASSES)[number]

export function isCallerClass(value: unknown): value is CallerClass {
  return typeof value === 'string' && (CALLER_CLASSES as readonly string[]).includes(value)
}

/** An outside channel (decision 14: each is an app-routed turn; Slack DMs are built, src/lib/slack/). */
export type OutsideChannel = 'slack' | 'sms' | 'call' | 'dial8'

/**
 * A principal some door verified. Each variant carries only the verified
 * facts its class depends on, as the door's own auth produced them.
 */
export type VerifiedPrincipal =
  /**
   * The chat-run token (src/lib/chat/chat-run-token.ts, HMAC-verified): the
   * in-app chat, a teammate chat, a bot conversation (`teammateIn`), a relayed
   * turn (`relay`), the device ask (`surface`), a server turn (`server`), and
   * a channel turn (`server: 'channel_turn'` with its channel's `surface`:
   * the person, verified at intake by that channel's route).
   */
  | { kind: 'chat_run'; claims: { surface?: string; server?: string; relay?: string; guestId?: string } }
  /** The skill-run token: a loop's run, or one follow-up chat turn on it (`chat`, relayed when `chat.relay`). */
  | { kind: 'skill_run'; claims: { chat?: { relay?: boolean } } }
  /**
   * The agent-run token on a work run: the run's own turns, or one follow-up
   * chat turn (`chat`), relayed by the main agent when `relay`.
   */
  | { kind: 'work_run'; claims: { chat?: boolean; relay?: boolean } }
  /** A coding run (the coding-agent): nobody is watching it. */
  | { kind: 'coding_run' }
  /** The live agent's run token: a turn on a live meeting, driven by what is said in it. */
  | { kind: 'live_agent' }
  /** The person's own Dial8 MCP connector (an mcp_oauth_token row they authorised). */
  | { kind: 'mcp_connector' }
  /** The person's own app session (Supabase auth): their own click. */
  | { kind: 'app_session' }
  /**
   * An outside channel's sender, verified at intake by the channel's own
   * route (a linked Slack user, a verified phone number). `senderUserId` is
   * who the channel verified the sender as (null: nobody it knows),
   * `ownerUserId` the person whose agent it is, `senderIsMember` whether the
   * sender is a member of the owner's workspace. `senderGuestId` is the
   * owner's ACTIVE guest (agent_guest, migration 427) the channel matched the
   * sender to (by text only: the guest's number, once their invite code
   * activated it), null when it matched none.
   */
  | {
      kind: 'channel'
      channel: OutsideChannel
      ownerUserId: string
      senderUserId: string | null
      senderIsMember: boolean
      senderGuestId?: string | null
      place: 'direct' | 'group'
    }

/** A chat-run token's surfaces, as the token verifier admits them. */
const KNOWN_CHAT_SURFACES: ReadonlySet<string> = new Set(['device_ask'])

/**
 * The outside channels a channel turn's token may name (twin of
 * CHANNEL_SURFACES in src/lib/chat/chat-run-token.ts; this module stays pure).
 */
const CHANNEL_TURN_SURFACES: ReadonlySet<OutsideChannel> = new Set<OutsideChannel>(['slack', 'sms', 'dial8', 'call'])

/**
 * The caller class of a verified principal. Fails closed: a principal this
 * does not know, or a chat-run token with a surface it does not know, is
 * 'unknown'.
 */
export function callerClassOf(principal: VerifiedPrincipal | null | undefined): CallerClass {
  if (!principal || typeof principal !== 'object') return 'unknown'
  switch (principal.kind) {
    case 'chat_run': {
      const claims = principal.claims ?? {}
      // A channel turn (decision 14): the person's own message from an
      // outside channel, written into their home thread by the server. Only
      // the channel's verified owner is ever sent as one (the Slack route
      // links a DM's sender to the token's user before it writes anything;
      // the SMS webhook matches the sender to their verified user_phone), so
      // its class is the owner's on that channel (channelCaller): `person` on
      // Slack, `person_remote` by text (caller ID can be spoofed).
      if (claims.server === 'channel_turn') {
        if (claims.relay !== undefined) return 'unknown'
        const channel = claims.surface as OutsideChannel | undefined
        if (!channel || !CHANNEL_TURN_SURFACES.has(channel)) return 'unknown'
        // A guest's text turn (migration 428): the person the owner added, by
        // text only, matched by the SMS webhook to their activated number.
        // A linked agent's turn (435) is a guest's too: the owner's half for that user.
        if (claims.guestId !== undefined) {
          return (channel === 'sms' || channel === 'dial8') && typeof claims.guestId === 'string' && claims.guestId ? 'guest' : 'unknown'
        }
        // A linked agent never speaks as the owner.
        if (channel === 'dial8') return 'unknown'
        return channelCaller({ channel, ownerUserId: 'owner', senderUserId: 'owner', senderIsMember: true })
      }
      // A turn the server started (a home turn, idle compaction), and a turn
      // the main agent relayed into a bot's thread: nobody is speaking for
      // the person in the conversation it runs in.
      if (claims.server !== undefined || claims.relay !== undefined) return 'agent_unattended'
      if (claims.surface !== undefined) return KNOWN_CHAT_SURFACES.has(claims.surface) ? 'person_remote' : 'unknown'
      return 'person'
    }
    case 'skill_run':
      if (!principal.claims?.chat) return 'agent_unattended'
      return principal.claims.chat.relay ? 'agent_unattended' : 'person'
    case 'work_run':
      if (!principal.claims?.chat) return 'agent_unattended'
      return principal.claims.relay ? 'agent_unattended' : 'person'
    case 'coding_run':
    case 'live_agent':
      return 'agent_unattended'
    case 'mcp_connector':
    case 'app_session':
      return 'person'
    case 'channel':
      return channelCaller(principal)
    default:
      return 'unknown'
  }
}

/**
 * An outside channel's caller class (decision 11, eve-templates-lessons §3.1):
 *   the owner: a Slack DM or thread from their linked Slack user is the
 *              person; an SMS or a call from their verified phone is the
 *              person, remote;
 *   another member of the workspace (a teammate in a shared channel or a
 *              group text): other_person;
 *   a guest the owner added, by text from their activated number, and only
 *              when the sender is nobody's own verified number: guest;
 *   anyone else: unknown.
 */
export function channelCaller(sender: Pick<Extract<VerifiedPrincipal, { kind: 'channel' }>, 'channel' | 'ownerUserId' | 'senderUserId' | 'senderIsMember' | 'senderGuestId'>): CallerClass {
  if (!sender.ownerUserId) return 'unknown'
  if (!sender.senderUserId) {
    // A guest texts the agent made for them; nobody is a guest on Slack or a call yet.
    return sender.channel === 'sms' && typeof sender.senderGuestId === 'string' && sender.senderGuestId ? 'guest' : 'unknown'
  }
  if (sender.senderUserId === sender.ownerUserId) return sender.channel === 'slack' ? 'person' : 'person_remote'
  return sender.senderIsMember ? 'other_person' : 'unknown'
}

/**
 * Decision 11, in a group thread: the agent replies only when it is
 * mentioned. In a direct conversation it always replies (an unknown sender
 * still gets one reply, with no tools: decideAction denies them every tool).
 */
export function channelShouldReply(place: 'direct' | 'group', mentioned: boolean): boolean {
  return place === 'direct' || mentioned === true
}

/**
 * Whose data a call runs over: the owner's for the owner, their own
 * unattended runs and their guests (a guest's agent acts for the owner, within
 * the tools the owner gave it); the ASKER's for another person (decision 11: answered only
 * from what they themselves can see, never from the owner's mail or chats);
 * nobody's for an unknown caller.
 */
export function runAsUserFor(caller: CallerClass, ids: { ownerUserId: string; callerUserId?: string | null }): string | null {
  if (caller === 'other_person') return ids.callerUserId || null
  if (caller === 'unknown' || !isCallerClass(caller)) return null
  return ids.ownerUserId || null
}

// ── The policy ──────────────────────────────────────────────────────────────

/**
 * What a call does, for the policy: the registry's class, 'unclassified' (an
 * external mcp__ tool or a name nobody classified), or 'outward': the outward
 * gate (outward-gate.ts) held this exact call, because it reaches people or
 * services outside Dial8 with no standing yes (a calendar invite to someone
 * outside the workspace, a connected app's write tool).
 */
export type PolicyEffect = ToolSideEffect | 'unclassified' | 'outward'

export type ActionDecision = 'run' | 'ask' | 'deny'

export interface DecideOptions {
  /**
   * The person granted this attended-only tool to the bot the call runs as
   * (a follow-through grant, src/lib/chat/follow-through.ts: settle_card for
   * the Captures bot, revise_email_draft for Mail). It reaches the bot's turns
   * the main agent relays, which are otherwise unattended: the person asked
   * the main agent, in their own chat, to have the bot do it. Read only for
   * an unattended caller.
   */
  granted?: boolean
  /**
   * A guest's own asks (agent_guest.ask_before, src/lib/guests/presets.ts):
   * 'deletes' holds a delete as the owner's card, 'changes' holds every
   * write. Read only for a guest. Missing reads as every ask (fail closed:
   * nothing writes without the owner's yes). 'payments' is the door's to
   * apply (a booking stops before it pays); the policy can't see a payment.
   * `allowed`: the owner set THIS tool to Always allow for this person (held,
   * and not among their Needs approval tools: agent_guest.ask_tools), which
   * wins over the defaults for an outward call or a delete (Liam, 2026-11-02:
   * "I get to control who can do that"); "any change at all" still holds.
   * Set only from the guest's stored row, never from a model.
   */
  guest?: { askBefore?: readonly string[] | null; allowed?: boolean }
  /**
   * F4 (flows-connectors.md §2.3): the call is a FLOW STEP's, made by a loop's
   * unattended run (a call_tool step, or a run_skill step's tool call), set
   * only from what the server verified (the run token's flowStep claim, the
   * runner's own call_tool executor), never from anything a model wrote. An
   * outward call there becomes the OWNER's approval card (ask), not a
   * refusal: the loop parks until they say yes, edit or skip. Read only for
   * an unattended caller and only for 'outward': every other unattended path
   * keeps deny.
   */
  flowStep?: boolean
  /**
   * The call is a HOME TURN's (a background update the server started in the
   * person's home thread), set only from the verified chat-run token
   * (`server === 'home_turn'`), never from anything a model wrote. As for a
   * flow step, an outward call there becomes the person's approval card (ask),
   * never a refusal: the agent does the work on its own and leaves every send
   * waiting for their yes (Liam, 2026-10-26). Read only for an unattended
   * caller and only for 'outward'.
   */
  homeTurn?: boolean
}

/** A tool's effect for the policy (its registry class, else 'unclassified'). */
export function policyEffectOf(toolName: string): PolicyEffect {
  const name = bareToolName(toolName)
  // The discovery meta-tool only lists what the caller's ceiling holds.
  if (name === 'search_tools') return 'read'
  return getToolSideEffect(name) ?? 'unclassified'
}

/** A Dial8 MCP name without its prefix (the registry's name). */
function bareToolName(toolName: string): string {
  return typeof toolName === 'string' ? toolName.replace(/^dial8_/, '') : ''
}

/**
 * The ONE policy (F2): may this caller make this call, given what it does?
 *
 *                     read   writes (internal, external,   outward   attended-only
 *                            delete, automation, unclassified)        tool
 *   person            run    run                            ask       run
 *   person_remote     run    run                            ask       deny
 *   agent_unattended  run    run                            DENY*     deny (run when granted)
 *   other_person      run*   deny                           deny      deny
 *   guest             run    run / ASK**                    ask       deny
 *   unknown           deny   deny                           deny      deny
 *
 *   * agent_unattended on a FLOW STEP (options.flowStep, F4) or a HOME TURN
 *     (options.homeTurn): outward is ASK, the owner's card (the loop parks on
 *     it; a home turn carries on without it). Every other unattended path (a
 *     work run, the live agent, a relayed turn) denies.
 *   * other_person reads run AS THEM (runAsUserFor), and never an outside
 *     app's tool (it would read the owner's account) or a main-chat-only tool
 *     (helpers, the relay to the bots: those act for the owner).
 *   ** guest: an internal or external write runs, unless its asks hold
 *     'changes'; a delete runs only when they hold neither 'deletes' nor
 *     'changes'; an automation write, an outside app's tool (unclassified)
 *     and a main-chat-only tool are denied. The guest-only tools
 *     (src/lib/guests/tools.ts) run for a guest and nobody else.
 *
 * 'run' is within the door's ceiling and its reviewer: an enforced
 * action.review may still hold a person's risky call as a card. 'ask' holds
 * the call as the owner's approval card (approvals.ts). 'deny' refuses it:
 * for an unattended caller that is NEEDS_PERSON, never a wait. Fails closed
 * on a class it does not know.
 */
export function decideAction(caller: CallerClass, effect: PolicyEffect, toolName: string, options: DecideOptions = {}): ActionDecision {
  if (!isCallerClass(caller) || caller === 'unknown') return 'deny'
  const name = bareToolName(toolName)
  if (GUEST_ONLY_TOOL_NAMES.has(name)) return caller === 'guest' ? 'run' : 'deny'
  if (caller === 'guest') return decideForGuest(effect, name, options.guest)
  if (caller === 'other_person') {
    const ownersOnly = name.startsWith('mcp__') || ATTENDED_ONLY_TOOL_NAMES.has(name) || CHAT_NATIVE_TOOL_NAMES.has(name)
    return effect === 'read' && !ownersOnly ? 'run' : 'deny'
  }
  if (effect === 'outward') {
    if (caller !== 'agent_unattended') return 'ask'
    // A flow step's outward call parks on the owner's card (F4), and a home
    // turn's waits on it; nothing else unattended does.
    return options.flowStep === true || options.homeTurn === true ? 'ask' : 'deny'
  }
  if (ATTENDED_ONLY_TOOL_NAMES.has(name)) {
    if (caller === 'person') return 'run'
    return caller === 'agent_unattended' && options.granted === true ? 'run' : 'deny'
  }
  return 'run'
}

/** The guest row of the policy table (see decideAction). */
function decideForGuest(effect: PolicyEffect, name: string, guest: DecideOptions['guest']): ActionDecision {
  if (name.startsWith('mcp__') || ATTENDED_ONLY_TOOL_NAMES.has(name) || CHAT_NATIVE_TOOL_NAMES.has(name)) return 'deny'
  if (effect === 'read') return 'run'
  if (effect === 'unclassified' || effect === 'automation-write') return 'deny'
  const askBefore = guest?.askBefore
  const asks = new Set(Array.isArray(askBefore) ? askBefore : ['payments', 'deletes', 'changes'])
  // "Any change at all asks you first": every write. The People tab takes it
  // off the moment the owner sets tools one by one, so while it stands they
  // haven't, and it holds (fail closed for a row that says both).
  if (asks.has('changes')) return 'ask'
  // The owner's Always allow for this tool: their word, over the defaults.
  if (guest?.allowed === true) return 'run'
  if (effect === 'outward') return 'ask'
  if (effect === 'delete') return asks.has('deletes') ? 'ask' : 'run'
  return 'run'
}

/**
 * The tool-route form of the policy: may this caller make this call at all?
 * Every internal tool route asks it after its own ceiling, from the class its
 * verified token maps to, and refuses a 'deny' (an 'ask' goes on to the
 * outward gate and the reviewer, which hold it). For every caller the routes
 * serve today it refuses nothing their ceilings admit (the ceilings already
 * drop what it denies); it is the fence that holds when a new door, or a
 * ceiling that drifts, would hand a caller more than its class allows.
 */
export function callerMayCall(caller: CallerClass, toolName: string, options: DecideOptions = {}): boolean {
  return decideAction(caller, policyEffectOf(toolName), toolName, options) !== 'deny'
}

/** What a model reads when callerMayCall refused its call. */
export function callerRefusalMessage(toolName: string): string {
  return `'${toolName}' isn't available to whoever is asking here, so nothing ran. Don't retry it; say what you would have done.`
}

/**
 * The attended-only tools a caller of this class never holds (without a
 * grant): what the device ask's surface, a server turn, a loop run and a work
 * run's own turns drop from their ceilings.
 */
export function attendedOnlyToolsDeniedTo(caller: CallerClass): string[] {
  return [...ATTENDED_ONLY_TOOL_NAMES].filter((name) => decideAction(caller, policyEffectOf(name), name) === 'deny')
}

// ── Approvals: the owner's own hand ─────────────────────────────────────────

/**
 * Whoever is saying yes (or no) to a held call. Built ONLY by a door that
 * verified the person themselves: the card's own click on their app session
 * (settle-card.ts, actor 'person'), or a reply bound by bindReplyToApproval
 * from a channel's verified sender. The model never builds one: settle_card,
 * accept_proposal and send_work_answer run as actor 'agent' and have none.
 */
export interface Approver {
  callerClass: CallerClass
  userId: string
}

/**
 * Decision 11: only the owner approves, from their own account. A held call
 * is approved only by the person it is held for, as the person (in the app,
 * or remote over a verified channel), never by another person, an unattended
 * run or anything unknown.
 */
export function mayApprove(approver: Approver | null | undefined, ownerUserId: string | null | undefined): boolean {
  if (!approver || !ownerUserId || !approver.userId) return false
  if (approver.callerClass !== 'person' && approver.callerClass !== 'person_remote') return false
  return approver.userId === ownerUserId
}

// ── Approval by reply (F3): a reply names ONE pending approval ──────────────
//
// By CODE only, for now: each approval's reference is its own reply code
// (approvalReplyCode, derived from its id), so it can't shift when another
// approval lands or settles between the question and the reply. Numbered
// replies ("Reply 1") need a persisted question→approval map per message
// sent, so "1" means what that message said; that is for the channel that
// sends the questions to add (none exists yet), not a live list position.

/** A pending approval a reply may name, by its reply code. */
export interface PendingApprovalRef {
  approvalId: string
  /** The person it is held for (tool_approval.user_id). */
  ownerUserId: string
  /** tool_approval.status; anything but 'pending' cannot be answered. Absent: pending. */
  status?: string | null
  /** tool_approval.expires_at; a lapsed one cannot be answered. */
  expiresAt?: string | null
}

export type ReplyBinding =
  | { bound: true; decision: 'approve' | 'decline'; approvalId: string }
  | { bound: false; reason: 'not_owner' | 'empty' | 'stray_yes' | 'no_match' | 'ambiguous' }

/** Words that only say yes, carrying no reference. */
const APPROVE_WORDS: ReadonlySet<string> = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'k', 'sure', 'approve', 'approved', 'confirm', 'confirmed',
  'go', 'ahead', 'do', 'it', 'send', 'please', 'pls', 'thanks', 'thank', 'you', 'reply', 'number', 'option',
])
/** Words that only say no. */
const DECLINE_WORDS: ReadonlySet<string> = new Set(['no', 'n', 'nope', 'nah', 'decline', 'declined', 'deny', 'denied', 'cancel', 'stop', 'dont', "don't", 'reject'])

function replyTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
}

/**
 * Bind a reply on an outside channel to ONE pending approval (F3). Pure.
 *
 * A reply counts only when it comes from the verified owner (mayApprove: the
 * person, in the app or remote) AND names exactly one of THEIR live pending
 * approvals by its reply code ("K7Q4", "yes K7Q4"). "no K7Q4" declines that
 * one. Everything else binds nothing:
 *   - a number ("1"): only a persisted per-message map may say what it means;
 *   - a stray "yes" (no reference), even with a single approval pending;
 *   - a reference to someone else's approval, or a reply from anyone else;
 *   - two references, a yes and a no together, or any other words mixed in;
 *   - a lapsed or already-settled approval.
 * A bound result is a yes from the owner's hand; the caller still runs the
 * approval through approveToolCall's own re-checks.
 */
export function bindReplyToApproval(
  replyText: string,
  replier: Approver | null | undefined,
  pendingApprovals: readonly PendingApprovalRef[],
  now: number = Date.now(),
  /** An approval's code. The channels pass the keyed one (src/lib/safety/reply-code.ts serverReplyCode). */
  codeOf: (approvalId: string) => string = approvalReplyCode,
): ReplyBinding {
  const tokens = replyTokens(typeof replyText === 'string' ? replyText : '')
  if (!tokens.length) return { bound: false, reason: 'empty' }
  if (!replier || (replier.callerClass !== 'person' && replier.callerClass !== 'person_remote') || !replier.userId) {
    return { bound: false, reason: 'not_owner' }
  }
  const saysYes = tokens.some((token) => APPROVE_WORDS.has(token))
  const saysNo = tokens.some((token) => DECLINE_WORDS.has(token))
  if (saysYes && saysNo) return { bound: false, reason: 'ambiguous' }
  const refs = [...new Set(tokens.filter((token) => !APPROVE_WORDS.has(token) && !DECLINE_WORDS.has(token)))]
  if (refs.length === 0) return { bound: false, reason: 'stray_yes' }
  if (refs.length > 1) return { bound: false, reason: 'ambiguous' }
  const ref = refs[0]
  const live = pendingApprovals.filter((p) =>
    p && typeof p.approvalId === 'string' && codeOf(p.approvalId).toLowerCase() === ref &&
    (p.status === undefined || p.status === null || p.status === 'pending') &&
    !(p.expiresAt && Date.parse(p.expiresAt) <= now))
  const mine = live.filter((p) => mayApprove(replier, p.ownerUserId))
  if (mine.length === 0) return { bound: false, reason: live.length ? 'not_owner' : 'no_match' }
  if (mine.length > 1) return { bound: false, reason: 'ambiguous' }
  return { bound: true, decision: saysNo ? 'decline' : 'approve', approvalId: mine[0].approvalId }
}

/** Unambiguous letters and digits (no 0/O, 1/I/L, 5/S, 2/Z, 8/B). */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'

/** The length of the codes the channels show (serverReplyCode): six, about 244 million of them. */
export const REPLY_CODE_LENGTH = 6

/** Whether a word only says yes or no (a code may never be one: it could not name anything). Pure. */
export function isYesOrNoWord(word: string): boolean {
  const w = word.toLowerCase()
  return APPROVE_WORDS.has(w) || DECLINE_WORDS.has(w)
}

/** The words that open a plain yes (a plain answer needs one of them, not only filler). */
const PLAIN_YES_WORDS: ReadonlySet<string> = new Set(['yes', 'y', 'yep', 'yeah', 'yup', 'ya', 'ok', 'okay', 'k', 'sure', 'approve', 'approved', 'confirm', 'confirmed', 'go', 'send', 'lgtm'])
/** The words that make a plain no. Never STOP or CANCEL: those are the carrier's opt-out words. */
const PLAIN_NO_WORDS: ReadonlySet<string> = new Set(['no', 'n', 'nope', 'nah', 'decline', 'declined', 'deny', 'denied', 'dont', "don't", 'reject', 'skip'])
/** Words a plain answer may carry around its yes or no ("yes do it", "go ahead with both", "no thanks"). */
const PLAIN_FILLER: ReadonlySet<string> = new Set([
  'i', 'do', 'it', 'ahead', 'please', 'pls', 'thanks', 'thank', 'you', 'that', 'this', 'them', 'those', 'these', 'both', 'all', 'with', 'for', 'now', 'just', 'sounds', 'good', 'great', 'fine', 'go',
])
/** The longest plain answer, in words. */
const PLAIN_MAX_WORDS = 8

/**
 * A plain yes or no by text, with no code (Liam, 2026-11-02: "it should just
 * be yes or no and I should be able to just say yes do it"): a short reply
 * made only of yes or no words and filler, with at least one real yes or no
 * word, never both. 'approve' for "yes", "yes do it", "go ahead", "approve
 * both", "ok"; 'decline' for "no", "nope", "don't do it", "no thanks"; null
 * for anything else (the text goes to the agent). STOP and CANCEL are never
 * a no: the carrier reads them as opting out. Pure.
 */
export function plainReplyDecision(replyText: string): 'approve' | 'decline' | null {
  const tokens = replyTokens(typeof replyText === 'string' ? replyText : '')
  if (tokens.length === 0 || tokens.length > PLAIN_MAX_WORDS) return null
  if (!tokens.every((t) => PLAIN_YES_WORDS.has(t) || PLAIN_NO_WORDS.has(t) || PLAIN_FILLER.has(t))) return null
  const yes = tokens.some((t) => PLAIN_YES_WORDS.has(t) && t !== 'go') || (tokens.includes('go') && tokens.includes('ahead'))
  const no = tokens.some((t) => PLAIN_NO_WORDS.has(t))
  if (yes === no) return null
  return yes ? 'approve' : 'decline'
}

/**
 * Whether a reply is shaped like an answer by code: 'bare' for the code alone
 * ("K7Q4MX"), 'worded' for one yes or no word and the code ("yes K7Q4MX", "no
 * K7Q4MX"); null for anything else. The code is REPLY_CODE_LENGTH characters
 * of the code alphabet. A reply shaped so that binds nothing (bindReplyToApproval's
 * 'no_match') is a wrong guess, which a channel whose sender can be faked
 * counts (src/lib/sms/approvals.ts). Pure.
 */
export function replyNamesACode(replyText: string): 'bare' | 'worded' | null {
  const tokens = replyTokens(typeof replyText === 'string' ? replyText : '')
  if (tokens.length === 0 || tokens.length > 2) return null
  const refs = tokens.filter((token) => !APPROVE_WORDS.has(token) && !DECLINE_WORDS.has(token))
  if (refs.length !== 1) return null
  const ref = refs[0].toUpperCase()
  if (ref.length !== REPLY_CODE_LENGTH || ![...ref].every((ch) => CODE_ALPHABET.includes(ch))) return null
  return tokens.length === 2 ? 'worded' : 'bare'
}

/**
 * A short, stable reply code for an approval ("K7Q4"): what a question asks
 * the person to reply with. Four characters from an unambiguous alphabet,
 * derived from the id (FNV-1a), so the same approval always shows the same
 * code; never a word a reply reads as a plain yes or no (YEAH, DENY, SEND...),
 * which could not name anything. Pure.
 */
export function approvalReplyCode(approvalId: string): string {
  for (let salt = 0; ; salt++) {
    const code = replyCodeOf(salt ? `${approvalId}#${salt}` : approvalId)
    const word = code.toLowerCase()
    if (!APPROVE_WORDS.has(word) && !DECLINE_WORDS.has(word)) return code
  }
}

function replyCodeOf(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let code = ''
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[hash % CODE_ALPHABET.length]
    hash = Math.floor(hash / CODE_ALPHABET.length)
  }
  return code
}

// ── Lasting memory (F8) ─────────────────────────────────────────────────────

/**
 * Who asked for a work run, stamped when it was started (Foreman's trusted
 * mention vs autonomous label): only `origin` 'user' (the person's own Start)
 * is the person's; every other origin, a row from before the column among
 * them, is unattended (fail closed). Recorded on what the run teaches, which
 * is always written and can be removed (decision 16: apply with undo).
 */
export function runStarterClass(origin: string | null | undefined): CallerClass {
  return origin === 'user' ? 'person' : 'agent_unattended'
}
