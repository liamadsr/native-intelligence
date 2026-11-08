/**
 * Automatic model selection (Liam, 2026-10-15): nobody picks a model. Three
 * tiers, decided by checkable rules, synchronously, with no round trip:
 *
 *   | Tier   | Model and call                    | Used for                               |
 *   | fast   | DeepSeek V4 Flash, thinking on    | everything by default                  |
 *   | think  | Flash, thinking `high`            | multi-step analysis; background runs   |
 *
 * Flash thinks at both (Liam, 2026-10-31: with thinking off it wrote its
 * reasoning into what a guest was texted), so Fast and Think differ only in
 * the turn's usage row, as they do on the main thread's model.
 *   | strong | STRONG_MODEL (newest Sonnet)      | coding, PDF ingest, strong helpers     |
 *
 * Max (`xhigh`) is never picked automatically.
 *
 * The main chat's thread (Liam, 2026-10-27) runs MAIN_MODEL (Haiku 5.5), or
 * the model the person picked for their main agent (./agent-model.ts), at
 * either tier (chatThreadModel), a device ask excepted, and the tier NEVER
 * changes its model: it only labels the turn's usage row. Switching the
 * thread would re-read the whole history uncached on a model with its own
 * cache, which only the person's own pick does, once.
 *
 * Helpers: the main agent picks each one's model from HELPER_MODELS
 * (src/lib/ai/models.ts), and the rules below pick only when it names none.
 * Strong, by the rules, is for clear signals: code, a repo, a diff, SQL or a
 * stack trace; synthesis across 10 or more sources; a cross-document
 * comparison ending in a recommendation; or an explicit "use the best model".
 * Every premium model (Strong, whoever picked it) is capped per person per
 * day (src/lib/ai/model-escalation-budget.ts).
 *
 * Where the rules can't tell, the turn runs Fast, and Jev's `model.tier`
 * (src/lib/ai/decisions/tasks/model-tier.ts) answers in SHADOW: logged, off
 * the hot path, changing nothing until JEV_TIER_MODE flips.
 *
 * Client-safe and pure: the transport computes the signals in the browser
 * (turnRouteSignals) and the spec rebuild decides from them (routeChatTurn).
 * A forged signal can only raise its sender's own tier, which the daily cap
 * bounds for Strong.
 */
import {
  DEFAULT_MODEL,
  MAIN_MODEL,
  STRONG_MODEL,
  chatModelPolicy,
  deepseekSurfacePolicy,
  helperModelEntry,
  helperModelForTier,
  isHelperModelKey,
  type ChatModelId,
  type ChatModelPolicy,
  type HelperModelKey,
  type ThinkingLevel,
} from './models'

export const MODEL_TIERS = ['fast', 'think', 'strong'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v)
}

/**
 * Who decided: the rules, Jev (enforce only), a Jev timeout (enforce only),
 * the Strong cap (or the plan clamp, or the kill switch), a fixed surface, or
 * the main chat's agent itself (a helper's `model`, HELPER_MODELS).
 */
export type RouteBy = 'rule' | 'jev' | 'timeout' | 'cap' | 'fixed' | 'agent'

/** What a turn or run logs as `model_route` in ai_usage_logs.metadata. */
export interface ModelRoute {
  tier: ModelTier
  by: RouteBy
  /** The rule names that fired (short snake_case words, never message text). */
  signals: string[]
  /** How the tier's model reasons: 'none', 'high', or 'adaptive' (Strong). */
  reasoning?: string
  /** A helper's roster key (HELPER_MODELS): the model it runs on. */
  model?: HelperModelKey
}

/**
 * Jev's model.tier runs in shadow: it answers only where the rules can't tell,
 * fire-and-forget, and the turn runs Fast whatever it says. Flipping this to
 * 'enforce' (after the shadow review) is the one line that lets an accepted
 * `think` answer change the turn; the enforce path is built and tested.
 */
export const JEV_TIER_MODE: 'shadow' | 'enforce' = 'shadow'

/**
 * The feature of the zero-cost ai_usage_logs rows that count Strong
 * escalations (model-escalation-budget.ts). Not usage: the admin usage views
 * leave them out.
 */
export const ESCALATION_FEATURE = 'model.escalation'

/**
 * The most premium (Strong) escalations a person gets per UTC day: helpers on
 * a premium roster model, whoever picked it (src/lib/ai/model-escalation-budget.ts
 * enforces it). Here, client-safe, so the main chat's prompt can name it.
 */
export const STRONG_DAILY_CAP = 10

/**
 * Whether automatic escalation to Strong is on: `AUTO_MODEL_ESCALATION=off`
 * turns every Strong into Think (a cost kill switch, not a runtime flag). Here
 * rather than in the budget so the spec rebuild can gate its strong hint
 * without the budget's reads.
 */
export function autoEscalationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AUTO_MODEL_ESCALATION ?? '').trim().toLowerCase() !== 'off'
}

// ── The tiers' models ───────────────────────────────────────────────────────

/** The app model id a tier runs on. */
export function tierModel(tier: ModelTier): ChatModelId {
  return (tier === 'strong' ? STRONG_MODEL : DEFAULT_MODEL) as ChatModelId
}

/** The chat level a tier calls its model at. */
export function tierLevel(tier: ModelTier): ThinkingLevel {
  return tier === 'fast' ? 'light' : 'standard'
}

/** How a tier's model is called (window, thinking, hosts). */
export function tierPolicy(tier: ModelTier): ChatModelPolicy {
  return chatModelPolicy(tierModel(tier), tierLevel(tier))
}

/** The reasoning a tier runs at, for the usage log. */
export function tierReasoning(tier: ModelTier): string {
  return tier === 'strong' ? 'adaptive' : (tierPolicy(tier).reasoning ?? 'none')
}

// ── The main chat's thread (MAIN_MODEL) ─────────────────────────────────────

/**
 * How a main-chat turn picks its model: a device ask, or the model the person
 * picked for their main agent (./agent-model.ts agentModelForTurn: null is
 * Auto, MAIN_MODEL).
 */
export interface ChatThreadModelOpts {
  device?: boolean
  chosen?: ChatModelId | null
}

/**
 * The model a main-chat turn runs on: MAIN_MODEL (Haiku 5.5), or the model
 * the person picked, for every turn but a device ask, which keeps its tier's
 * model (Flash: a quick answer someone waits on) whatever they picked.
 * The tier still decides the level and the usage row.
 * A device ask is the one chat call to DeepSeek with thinking off: its route
 * has 60 s (/api/device/ask maxDuration) for up to 12 steps, which a step's
 * reasoning (up to 5-8K tokens at ~100 tokens/s) can spend alone.
 */
export function chatThreadModel(tier: ModelTier, opts: ChatThreadModelOpts = {}): ChatModelId {
  if (opts.device) return tierModel(tier)
  return opts.chosen ?? (MAIN_MODEL as ChatModelId)
}

/** How a main-chat turn's model is called (window, thinking, hosts). */
export function chatThreadPolicy(tier: ModelTier, opts: ChatThreadModelOpts = {}): ChatModelPolicy {
  const model = chatThreadModel(tier, opts)
  return (opts.device && deepseekSurfacePolicy(model, 'off')) || chatModelPolicy(model, tierLevel(tier))
}

/**
 * The reasoning a main-chat turn runs at, for the usage log: its policy's,
 * else 'adaptive' (the Claude 5.5 models, Haiku 5.5 among them, think
 * adaptively when sent none).
 */
export function chatThreadReasoning(tier: ModelTier, opts: ChatThreadModelOpts = {}): string {
  return chatThreadPolicy(tier, opts).reasoning ?? 'adaptive'
}

// ── A helper's model (HELPER_MODELS) ────────────────────────────────────────

/** The route of a helper task whose model the main agent chose. */
export function helperRouteForModel(key: HelperModelKey, by: RouteBy, signals: string[]): ModelRoute {
  const entry = helperModelEntry(key)
  const reasoning = chatModelPolicy(entry.model, entry.level).reasoning ?? 'adaptive'
  return { tier: entry.tier, by, signals, reasoning, model: key }
}

/** The roster key a route runs on: its own, else its tier's (helperModelForTier). */
export function routeHelperModel(route: Pick<ModelRoute, 'tier' | 'model'>): HelperModelKey {
  return route.model ?? helperModelForTier(route.tier)
}

// ── The per-turn signals (computed in the browser) ──────────────────────────

/** The longest message excerpt a turn's ctx carries. */
export const ROUTE_EXCERPT_MAX = 800
const EXCERPT_HEAD = 600
const MAX_ATTACHMENT_KINDS = 8
/** A fenced code block counts from this many lines. */
const CODE_FENCE_MIN_LINES = 10

/**
 * What the transport sends in each turn's ctx as `route`, in place of the old
 * `{model, thinking}`: enough to apply the rules without the full message.
 */
export interface TurnRouteSignals {
  /** The message, or its head and tail when longer than ROUTE_EXCERPT_MAX. */
  excerpt: string
  /** The whole message's length. */
  chars: number
  /** One word per attached file: pdf, csv, xlsx, image, text or other. */
  attachmentKinds: string[]
  /** Fenced code blocks of CODE_FENCE_MIN_LINES lines or more. */
  codeFences: number
  /** Numbered or bulleted lines. */
  listItems: number
}

/** A file's kind from its name and type. */
export function attachmentKind(file: { fileName?: unknown; mimeType?: unknown }): string {
  const mime = typeof file.mimeType === 'string' ? file.mimeType.toLowerCase() : ''
  const name = typeof file.fileName === 'string' ? file.fileName.toLowerCase() : ''
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (mime.includes('csv') || name.endsWith('.csv')) return 'csv'
  if (mime.includes('spreadsheet') || mime.includes('excel') || /\.xlsx?$/.test(name)) return 'xlsx'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || /\.(md|txt|json)$/.test(name)) return 'text'
  return 'other'
}

/** The message's head and tail, so an ask at either end survives the cut. */
export function routeExcerpt(text: string): string {
  if (text.length <= ROUTE_EXCERPT_MAX) return text
  const tail = ROUTE_EXCERPT_MAX - EXCERPT_HEAD - 1
  return `${text.slice(0, EXCERPT_HEAD)}…${text.slice(text.length - tail)}`
}

/** Fenced code blocks of at least CODE_FENCE_MIN_LINES lines. */
export function countCodeFences(text: string): number {
  let count = 0
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (match[1].split('\n').filter((l) => l.trim()).length >= CODE_FENCE_MIN_LINES) count++
  }
  return count
}

/** Numbered or bulleted lines. */
export function countListItems(text: string): number {
  return text.split('\n').filter((l) => /^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/.test(l)).length
}

/** The signals for a message and its uploads (the composer's chatFiles meta). */
export function turnRouteSignals(text: string, files: readonly unknown[] = []): TurnRouteSignals {
  const kinds = files
    .filter((f): f is { fileName?: unknown; mimeType?: unknown } => !!f && typeof f === 'object')
    .map(attachmentKind)
    .slice(0, MAX_ATTACHMENT_KINDS)
  return {
    excerpt: routeExcerpt(text),
    chars: text.length,
    attachmentKinds: kinds,
    codeFences: countCodeFences(text),
    listItems: countListItems(text),
  }
}

const count = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

/** The ctx's `route`, shape-guarded; null when absent or malformed. */
export function parseTurnRouteSignals(raw: unknown): TurnRouteSignals | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.excerpt !== 'string') return null
  const chars = count(r.chars, 10_000_000)
  const codeFences = count(r.codeFences, 1000)
  const listItems = count(r.listItems, 100_000)
  if (chars === null || codeFences === null || listItems === null) return null
  const kinds = Array.isArray(r.attachmentKinds)
    ? r.attachmentKinds.filter((k): k is string => typeof k === 'string' && /^[a-z]{1,8}$/.test(k)).slice(0, MAX_ATTACHMENT_KINDS)
    : []
  return { excerpt: r.excerpt.slice(0, ROUTE_EXCERPT_MAX), chars, attachmentKinds: kinds, codeFences, listItems }
}

// ── The rules ───────────────────────────────────────────────────────────────

/** An explicit ask to think: Think in the main chat. */
const THINK_ASK = /\b(?:think (?:hard|harder|carefully|deeply|it through|this through)|step[- ]by[- ]step|take your time|be thorough|thoroughly|deep[- ]dive|reason (?:it|this) (?:out|through))\b/i
/** A retry after a wrong answer: Think. */
const RETRY = /\b(?:that'?s (?:wrong|not right|incorrect)|(?:that is|this is|you'?re|you are) (?:wrong|incorrect)|try again|not what i (?:asked|meant)|wrong answer)\b/i
/** Verbs that make an attached spreadsheet or PDF an analysis job. */
const ANALYSIS_VERB = /\b(?:compare|comparison|analy[sz]e|analysis|evaluate|assess|plan|forecast|reconcile|model(?:l)?ing|projections?|trade-?offs?|pros and cons|root cause)\b/i
/** "Use the best model" and the like: Strong for helpers (and the hint in chat). */
const BEST_MODEL = /\b(?:(?:use|with|on|switch to|give me) (?:the|your) (?:best|strongest|smartest|most capable|most powerful|top) (?:model|ai)|best model|strongest model|smartest model|most capable model)\b/i
/** A short confirmation: always Fast. */
const CONFIRMATION = /^\s*(?:y(?:es|ep|eah|up)?|no(?:pe)?|ok(?:ay)?|k|sure|thanks?|thank you|ty|great|perfect|cool|nice|done|go(?: ahead)?|do it|send(?: it)?|ship it|sounds good|looks good|lgtm|please do|approved?|confirm(?:ed)?|correct|right)[\s.!]*$/i
/** Mail, calendar and CRM work: Fast under FAST_TASK_MAX_CHARS. */
const ROUTINE_VERB = /\b(?:draft|reply|respond|forward|send|email|e-mail|inbox|schedule|reschedule|book|calendar|meeting|invite|move|cancel|remind|add|create|update|log|find|look up|lookup|search|show|list|open|contact|company|deal|lead|follow[- ]?up)\b/i
const SHORT_CHARS = 280
const FAST_TASK_MAX_CHARS = 800
const LONG_CHARS = 4000
const MANY_LIST_ITEMS = 3

/**
 * Coding, as clear signals only. The HARD ones are the work itself in the
 * message (a long code block, a diff, a stack trace, SQL): they make a helper
 * Strong even when its task also reads like routine work. The soft ones (a
 * code file by its path, words only engineering uses) count only where
 * nothing says the work is routine. Never a bare "repo" or "PR #12" (a repo
 * rate, a launch PR), never `Name.js` in prose (a site built on Next.js).
 */
const DIFF = /^(?:diff --git |@@ -\d|\+\+\+ [ab]\/|--- [ab]\/)/m
const STACK_TRACE = /(?:Traceback \(most recent call last\)|^\s+at [\w$.<>]+ \(.+:\d+:\d+\)|^\s+at .+:\d+:\d+$|Exception in thread "|^\s*File ".+", line \d+|\bpanicked at\b|Uncaught (?:Type|Reference|Syntax)Error)/m
const SQL = /\b(?:select\s+(?:\*|distinct\s|count\s*\(|[\w.]+\s*,\s*[\w.]+)[^;]{0,300}?\sfrom\s+[\w."]+|insert\s+into\s+[\w."]+\s*\(|update\s+[\w."]+\s+set\s+\w+\s*=|delete\s+from\s+[\w."]+\s+where\s|create\s+(?:table|index|view)\s|alter\s+table\s)/i
const CODE_EXT = '(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|sql|sh|ya?ml|toml)'
/** A code file by its path (`src/lib/a.ts`) or quoted as code (`` `a.ts` ``), never a name in prose. */
const CODE_FILE = new RegExp(`(?:(?:^|[\\s'"(])(?:[\\w.-]+/)+[\\w.-]+\\.${CODE_EXT}\\b|\`[\\w./-]+\\.${CODE_EXT}\`)`)
const REPO = /\b(?:repository|codebase|pull request|git (?:branch|commit|diff|rebase|merge)|merge conflict|unit tests?|refactor(?:ing)? (?:the|this|our) (?:code|function|component|module)|compile error|type ?error|lint(?:er)? errors?)\b/i
/** Synthesis across ten or more sources. */
const MANY_SOURCES = /\b(?:1\d|[2-9]\d|\d{3,}|ten|eleven|twelve|fifteen|twenty|thirty|fifty|dozens? of) (?:\w+ ){0,2}(?:documents|docs|sources|reports|files|papers|articles|transcripts|contracts|pages|studies|filings)\b/i
/** Three or more documents or options named in the text (a comparison that size is Strong work). */
const THREE_PLUS = /\b(?:three|four|five|six|seven|eight|nine|[3-9]|\d{2,}) (?:\w+ ){0,2}(?:documents|docs|contracts|proposals|reports|files|pdfs|decks|papers|spreadsheets|quotes|bids|offers|vendors|options|agencies|candidates)\b/i
/** A comparison across documents… */
const CROSS_DOC = /\b(?:compare|comparison|versus|vs\.?|side[- ]by[- ]side|contrast|across (?:these|the|all|both))\b/i
/** …ending in a recommendation. */
const RECOMMEND = /\b(?:recommend|recommendation|which (?:one |of them |option )?(?:should|is best|to (?:pick|choose|go with))|what should (?:we|i) (?:pick|choose|do)|decide|decision)\b/i
const DOCUMENTS = /\b(?:documents?|docs?|contracts?|proposals?|reports?|files?|pdfs?|decks?|papers?|spreadsheets?|quotes|bids|offers)\b/i

/** The HARD coding signals: the code, diff, trace or SQL is in the text itself. */
const HARD_CODE_SIGNALS: readonly string[] = ['code_block', 'diff', 'stack_trace', 'sql']

/** The coding signals that fired (rule names). */
export function codingSignals(text: string, codeFences = countCodeFences(text)): string[] {
  const out: string[] = []
  if (codeFences > 0) out.push('code_block')
  if (DIFF.test(text)) out.push('diff')
  if (STACK_TRACE.test(text)) out.push('stack_trace')
  if (SQL.test(text)) out.push('sql')
  if (CODE_FILE.test(text)) out.push('code_file')
  if (REPO.test(text)) out.push('code_words')
  return out
}

/**
 * The complex-work signals that fired: `strong` (synthesis across ten or more
 * sources; a cross-document comparison ending in a recommendation over three
 * or more documents or attachments) and `think` (the same comparison over
 * fewer: careful, but not Strong work).
 */
export function complexSignals(text: string, attachments = 0): { strong: string[]; think: string[] } {
  const strong: string[] = []
  const think: string[] = []
  if (MANY_SOURCES.test(text)) strong.push('many_sources')
  if (CROSS_DOC.test(text) && RECOMMEND.test(text) && DOCUMENTS.test(text)) {
    if (attachments >= 3 || THREE_PLUS.test(text)) strong.push('cross_doc_recommendation')
    else think.push('cross_doc_recommendation')
  }
  return { strong, think }
}

/** Whether the text asks for the best model. */
export function asksBestModel(text: string): boolean {
  return BEST_MODEL.test(text)
}

/** Whose turn this is, as the token says: only a person's own message is routed by its text. */
export type TurnKind = 'person' | 'server' | 'relay' | 'device' | 'channel'

export interface ChatTurnRoute extends ModelRoute {
  tier: 'fast' | 'think'
  /** Strong work the thread hands off: the turn context then names a strong helper or a coding run. */
  strongHint: 'coding' | 'complex' | 'best_model' | null
  /** The rules could not tell: the turn runs Fast, and Jev may answer in shadow. */
  undecided: boolean
  /** Jev is worth asking (long enough, or an analysis verb), when undecided. */
  askJev: boolean
}

/**
 * The main chat's tier for one turn. Pure and synchronous: it runs inside the
 * spec rebuild and adds nothing before the first token.
 *
 *   - Not a person's message (a server turn, a relayed one) or no signals: Fast.
 *   - The device ask: Fast, fixed.
 *   - Think on an explicit ask, a message over 4,000 characters, two or more
 *     attachments (or a PDF/CSV/XLSX with an analysis verb), three or more
 *     listed asks, or a retry after a wrong answer.
 *   - Fast without asking anyone for a short message (under 280 characters,
 *     no explicit ask), a confirmation, or mail/calendar/CRM work under 800.
 *   - Coding, complex work or "the best model" never changes the thread's
 *     tier: the turn carries the strong hint instead.
 */
export function routeChatTurn(signals: TurnRouteSignals | null, kind: TurnKind): ChatTurnRoute {
  const route = (tier: 'fast' | 'think', by: RouteBy, fired: string[], rest: Partial<ChatTurnRoute> = {}): ChatTurnRoute => ({
    tier,
    by,
    signals: fired,
    reasoning: tierReasoning(tier),
    strongHint: null,
    undecided: false,
    askJev: false,
    ...rest,
  })
  if (kind === 'device') return route('fast', 'fixed', ['device_ask'])
  if (kind !== 'person') return route('fast', 'rule', [`${kind}_turn`])
  if (!signals) return route('fast', 'rule', ['no_signals'])

  const text = signals.excerpt
  const think: string[] = []
  const explicitAsk = THINK_ASK.test(text)
  if (explicitAsk) think.push('explicit_ask')
  if (signals.chars > LONG_CHARS) think.push('long_message')
  const docs = signals.attachmentKinds.filter((k) => k === 'pdf' || k === 'csv' || k === 'xlsx').length
  if (signals.attachmentKinds.length >= 2) think.push('attachments')
  else if (docs > 0 && ANALYSIS_VERB.test(text)) think.push('document_analysis')
  if (signals.listItems >= MANY_LIST_ITEMS) think.push('many_asks')
  if (RETRY.test(text)) think.push('retry')
  const complex = complexSignals(text, signals.attachmentKinds.length)
  think.push(...complex.think)

  const coding = codingSignals(text, signals.codeFences)
  const best = asksBestModel(text)
  const strongHint = coding.length > 0 ? 'coding' : complex.strong.length > 0 ? 'complex' : best ? 'best_model' : null
  const hintSignals = [...coding, ...complex.strong, ...(best ? ['best_model'] : [])]

  if (think.length > 0) return route('think', 'rule', [...think, ...hintSignals], { strongHint })

  const confirmation = CONFIRMATION.test(text)
  const short = signals.chars < SHORT_CHARS
  const routine = signals.chars < FAST_TASK_MAX_CHARS && ROUTINE_VERB.test(text)
  const decided = confirmation ? 'confirmation' : short ? 'short' : routine ? 'routine_task' : null
  if (decided || strongHint) return route('fast', 'rule', [...(decided ? [decided] : []), ...hintSignals], { strongHint })
  return route('fast', 'rule', ['undecided'], {
    undecided: true,
    askJev: signals.chars > SHORT_CHARS || ANALYSIS_VERB.test(text),
  })
}

/**
 * The line a turn's context carried when its work belonged on Strong, while
 * the thread ran Flash. The thread now runs MAIN_MODEL, which picks its
 * helpers' models itself (renderHelperModelRoster), so the chat no longer
 * sends it; kept for the route's signals and older callers.
 */
export function strongHintLine(hint: NonNullable<ChatTurnRoute['strongHint']>): string {
  const what =
    hint === 'coding'
      ? 'This looks like coding work.'
      : hint === 'complex'
        ? 'This looks like complex analysis across many sources.'
        : 'The person asked for the best model.'
  return (
    `${what} Do not do it yourself on this thread: start a helper for it (helpers, or start_helper for longer work), ` +
    'with the code, files or sources it needs in the task, and it runs on the strong model; for changes to a repository, start a coding run.'
  )
}

/** Mail, calendar, CRM, prospecting and browser work: a helper's Fast work. */
const FAST_HELPER_WORK = /\b(?:drafts?|repl(?:y|ies)|e-?mails?|inbox|threads?|calendar|meetings?|schedule|invites?|contacts?|crm|deals?|leads?|prospect(?:s|ing)?|browser|websites?|look up|lookup|find|list|read|summari[sz]e|recap|notes?)\b/i

export interface HelperTaskRoute extends ModelRoute {
  /** The rules could not tell: the caller's default applies, and Jev may answer in shadow. */
  undecided: boolean
}

/**
 * A helper task's tier, before it starts.
 *   - Strong on the code itself in the task (a code block, a diff, a stack
 *     trace, SQL) or "the best model" in the task or in the person's own
 *     message this turn (Liam: it forces Strong, counted against the cap).
 *   - Fast for reading, finding, listing, drafting or summarizing, and mail,
 *     calendar, CRM, prospecting or browser work: that wins over every softer
 *     signal ("find the CTO of Acme; they use Node.js" is not Sonnet work).
 *   - Strong on the softer ones otherwise: a code file by its path or
 *     engineering words; synthesis across ten or more sources; a
 *     cross-document comparison ending in a recommendation over three or more.
 *     The same comparison over fewer is Think.
 *   - Anything else is `defaultTier` (Think for a background helper, the
 *     thread's own tier for a quick one), undecided.
 * Strong is only what the rules want: the cap and the plan apply after
 * (grantStrong).
 */
export function routeHelperTask(task: string, opts: { turnExcerpt?: string; defaultTier: ModelTier; requested?: HelperModelKey }): HelperTaskRoute {
  // The main agent chose the model (HELPER_MODELS): that decides. The plan,
  // the cap and a server start's ceiling still apply after (decideHelperTiers).
  if (opts.requested) return { ...helperRouteForModel(opts.requested, 'agent', [`chose_${opts.requested.replace(/-/g, '_')}`]), undecided: false }
  const strongRoute = (signals: string[]): HelperTaskRoute => ({ tier: 'strong', by: 'rule', signals, reasoning: tierReasoning('strong'), undecided: false })
  const coding = codingSignals(task)
  const hard = coding.filter((s) => HARD_CODE_SIGNALS.includes(s))
  const best = asksBestModel(task) || (opts.turnExcerpt ? asksBestModel(opts.turnExcerpt) : false)
  if (hard.length > 0 || best) return strongRoute([...hard, ...(best ? ['best_model'] : [])])
  if (FAST_HELPER_WORK.test(task)) return { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: tierReasoning('fast'), undecided: false }
  const complex = complexSignals(task)
  const soft = [...coding, ...complex.strong]
  if (soft.length > 0) return strongRoute(soft)
  if (complex.think.length > 0) return { tier: 'think', by: 'rule', signals: complex.think, reasoning: tierReasoning('think'), undecided: false }
  return { tier: opts.defaultTier, by: 'rule', signals: ['default'], reasoning: tierReasoning(opts.defaultTier), undecided: true }
}

/** A route as `model_route` metadata: plain JSON, signals capped. */
export function modelRouteMetadata(route: ModelRoute): ModelRoute {
  return {
    tier: route.tier,
    by: route.by,
    signals: route.signals.slice(0, 12),
    ...(route.reasoning ? { reasoning: route.reasoning } : {}),
    ...(route.model ? { model: route.model } : {}),
  }
}

const ROUTE_BYS: readonly RouteBy[] = ['rule', 'jev', 'timeout', 'cap', 'fixed', 'agent']

/** A `model_route` off the wire (an agent's usage report), shape-guarded; null when not one. */
export function parseModelRoute(raw: unknown): ModelRoute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isModelTier(r.tier) || !ROUTE_BYS.includes(r.by as RouteBy)) return null
  const signals = Array.isArray(r.signals)
    ? r.signals.filter((s): s is string => typeof s === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(s)).slice(0, 12)
    : []
  const reasoning = typeof r.reasoning === 'string' && /^[a-z-]{1,16}$/.test(r.reasoning) ? r.reasoning : undefined
  const model = isHelperModelKey(r.model) ? r.model : undefined
  return { tier: r.tier, by: r.by as RouteBy, signals, ...(reasoning ? { reasoning } : {}), ...(model ? { model } : {}) }
}
