/**
 * The per-turn context block (chat-ttft P3): what the turn-context instructions
 * resolver (../instructions/turn-context.ts) sends as a user-role message before
 * the user's own.
 *
 * Providers cache a prompt by its exact prefix. The spec's system prompt now
 * carries only what stays the same from turn to turn; the clock, the view,
 * attachments, mentions and the other per-turn layers ride `spec.turnContext`
 * instead, and land here. eve appends a user-role instruction result to the
 * session's durable history before the current delivery, so the history up to
 * the new message stays a cached prefix.
 *
 * ── The block ───────────────────────────────────────────────────────────────
 *   <turn-context id="9c41e07b2d5a">
 *   <section key="time" v="3f2a9c1b04de">
 *   Current date and time: …
 *   </section>
 *   <section key="editor-selection" cleared="true"/>
 *   </turn-context id="9c41e07b2d5a">
 *
 * One `<section>` per key, its opening tag alone on its line, carrying a short
 * hash of the body (`v`). A key the previous block sent that this turn no
 * longer has is marked `cleared`, unless the spec says its layer failed to load
 * this turn (`held`): then nothing is said about it, and the version the model
 * has stands. The standing contract in ../instructions.md tells the model how
 * to read it.
 *
 * ── Dedupe, stateless ───────────────────────────────────────────────────────
 * A section goes out only when it differs from the version the model can still
 * see, and `time` always does. "The version it can still see" is read off the
 * history the resolver is handed (`ctx.messages`: the session's projected
 * history before this turn), from the opening tags of the earlier blocks only.
 * The bodies are never parsed or trusted. That makes it replay-safe by
 * construction: a retried or replayed turn step sees the same pre-turn history
 * and sends the same sections. After compaction or a clear, a summarized or
 * dropped block no longer counts, so everything goes out again.
 *
 * Compaction runs later than this, before a model call inside the turn, and
 * summarizes all but the last few messages: a section the model last saw in an
 * old block would be summarized away for the rest of that turn. So once the
 * pre-turn history nears eve's compaction threshold (nearCompaction), the
 * resolver dedupes against nothing and every present section goes out again.
 * nearCompaction is a history-only proxy: eve decides on the provider-reported
 * input tokens of the last call (system prompt and tools included), which the
 * resolver never sees, so the proxy leans early. Two gaps are left, and the
 * next turn restores both: (a) a turn that starts under the mark and crosses
 * eve's threshold inside its own tool loop (a few long tool results) loses the
 * sections last sent in older blocks for the rest of that turn; (b) a long
 * tool loop can summarize this turn's own block.
 *
 * ── Append-only sections (the log, A2b) ─────────────────────────────────────
 * A section in APPEND_ONLY (`log`: the person's agent log,
 * src/lib/log/log-section.ts) carries its lines with their ids (`entries`,
 * the newest few, oldest first) and a `heading`. It is not diffed by its
 * hash: its tag carries a cursor, the highest line id sent so far
 * (`<section key="log" v="…" through="1234">`), and a block sends only the
 * lines with an id past the cursor the latest earlier `log` tag in the
 * history carries, under the heading. No earlier tag (the conversation's
 * first turn, or after compaction or a clear), or near compaction: every line
 * goes out. No new line: no section at all. An append-only key is never
 * marked `cleared`: lines don't stop having happened, and a turn whose read
 * failed simply sends none. Like the rest, it is read off the opening tags
 * alone, so a replay over the same history sends the same block, and no
 * earlier block ever changes.
 *
 * ── After a checkpoint (the recent exchange, A3) ───────────────────────────
 * A section in AFTER_CHECKPOINT_ONLY (`recent`: the last few messages of the
 * conversation, word for word) goes out only on the first turn after a
 * checkpoint (firstTurnAfterCheckpoint: eve's `context.compaction` marker in
 * the history and no turn-context block after it), whatever its hash, and is
 * never marked `cleared`. Read off the history alone, like the rest.
 *
 * ── Never cleared ("while you were away", A6) ──────────────────────────────
 * A section in NEVER_CLEARED (`away`: what happened since the person's last
 * message, src/lib/agent-events/away-section.ts) is diffed by its hash like any
 * other, so the same section never goes out twice, but a turn without it does
 * not mark it `cleared`: the spec sends it only on the first turn after a gap,
 * and what happened while the person was away stays true afterwards.
 *
 * ── A held call's outcome (GEN-1172) ───────────────────────────────────────
 * Each call the conversation held for the person's approval and they settled
 * is its own section, keyed `approval-<12 hex of its id>` (the app's
 * src/lib/safety/approval-results.ts). Diffed by its hash, so each goes out
 * once, and never marked `cleared` (NEVER_CLEARED_PREFIXES): its card ran it
 * outside any turn, and what it returned stays true.
 *
 * ── Fence ───────────────────────────────────────────────────────────────────
 * Bodies carry text Native Intelligence does not control: email threads, CRM cards,
 * transcripts, file names, editor selections. The block's closing tag carries
 * its id, a hash over everything inside it, and the standing contract says only
 * the closing tag with that id ends the block. A body cannot carry the hash of
 * a block that contains it, so no spelling of `</turn-context>` in a body
 * (zero-width characters, entities, fullwidth brackets) can end the block and
 * make the rest read as the user's own words. Section tag look-alikes in a
 * body, in those spellings too, get their `<` replaced with `‹`
 * (neutralizeTags), so a body cannot forge a section version either; and only
 * `context.instruction` messages that start with the block are parsed.
 */
import { createHash } from 'node:crypto'
import type { ChatTurnContextSection } from './spec-client.js'
import { chatCompactionWindow, EVE_COMPACTION_THRESHOLD_PERCENT } from './compaction-window.js'

/** The block's first line, `<turn-context id="…">`: the id is 12 hex digits. */
const OPEN_RE = /^<turn-context id="[0-9a-f]{12}">\n/

/** Section keys as the app names them (TURN_CONTEXT_KEYS in src/lib/ai/chat-system-prompt.ts). */
const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/

/** More sections than any spec sends (TURN_CONTEXT_KEYS has 33); a runaway list is cut here. */
const MAX_SECTIONS = 64

/** Sent every turn even when unchanged: the newest block always says what time it is. */
const ALWAYS_SENT = new Set(['time'])

/**
 * Sections sent append-only past a cursor rather than diffed by hash (see the
 * file header): never cleared, and their tag carries `through`.
 */
const APPEND_ONLY = new Set(['log'])

/**
 * Sections sent once, on the first turn after a checkpoint, and never diffed or
 * cleared (`recent`, A3: the conversation's last few messages word for word,
 * src/lib/chat/recent-section.ts). See firstTurnAfterCheckpoint.
 */
const AFTER_CHECKPOINT_ONLY = new Set(['recent'])

/**
 * Sections diffed by hash but never marked `cleared` when a later turn lacks
 * them (`away`, A6: sent by the spec only on the first turn after a gap;
 * `product-facts`, canon D1: sent only on a turn that needs product facts,
 * and the facts stay true after it).
 */
const NEVER_CLEARED = new Set(['away', 'product-facts'])

/**
 * A held call's outcome (`approval-<12 hex of its id>`, GEN-1172:
 * src/lib/safety/approval-results.ts): one section per call the conversation
 * raised and the person settled, diffed by its hash like any other, so each
 * goes out once (and again when the call goes from running to ran), and never
 * marked cleared: a call that ran stays ran after the spec stops listing it.
 * A guest's note to the owner (`guest-note-<12 hex of its id>`,
 * src/lib/guests/guest-notes.ts) likewise: what they said stays said.
 */
const NEVER_CLEARED_PREFIXES = ['approval-', 'guest-note-'] as const

/** Whether a turn without `key` leaves it standing, rather than marking it cleared. */
function neverCleared(key: string): boolean {
  return NEVER_CLEARED.has(key) || NEVER_CLEARED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** A line id: a positive decimal bigint, no leading zero. */
const ENTRY_ID_RE = /^[1-9][0-9]{0,18}$/

/** More lines than the app sends (30); a runaway list is cut here. */
const MAX_ENTRIES = 60

/** A line or heading longer than this is no line the app wrote. */
const MAX_ENTRY_CHARS = 400

/** The heading when the spec sent none. */
const DEFAULT_APPEND_HEADING = 'Log: what happened in this workspace lately, one dated line each, oldest first.'

/** An opening tag the renderer writes, alone on its line: a version (and an append-only cursor), or `cleared`. */
const OPENING_TAG_RE =
  /^<section key="([a-z][a-z0-9-]{0,39})" (?:v="([0-9a-f]{12})"(?: through="([1-9][0-9]{0,18})")?>|cleared="true"\/>)$/

/**
 * A `<` that opens a turn-context or section tag, in any case or spacing: an
 * ASCII or fullwidth bracket or its HTML entity, with whitespace or invisible
 * format characters (zero-width space, word joiner, soft hyphen…) anywhere
 * around the slash or in place of the hyphen.
 */
const TAG_LOOKALIKE_RE =
  /(?:<|\uFF1C|\uFE64|&lt;?|&#0*60;?|&#x0*3c;?)(?=[\s\p{Cf}]*[/\uFF0F]?[\s\p{Cf}]*(?:turn[\s\p{Cf}_-]*context|section)(?![a-z0-9]))/giu

/**
 * eve's compaction threshold when the model's context window is unknown
 * (createCompactionConfig in eve/dist/src/execution/session.js: the agent's
 * thresholdPercent of the window, else 100k tokens).
 */
const EVE_DEFAULT_COMPACTION_THRESHOLD = 100_000

/**
 * What eve counts on top of the history (the system prompt and the tool
 * schemas), taken off the threshold before RESEND_ALL_AT applies. A rough
 * allowance, capped at half the threshold so a small window keeps a budget.
 */
const ENVELOPE_ALLOWANCE_TOKENS = 25_000

/**
 * The share of what is left of eve's threshold, after the envelope, the
 * pre-turn history may fill before every section goes out again. This turn's
 * own messages come on top, so it sits well below it.
 */
const RESEND_ALL_AT = 0.6

/**
 * Shape-guard a spec's `turnContext`. Null when it is absent or not a list (an
 * app that predates the split, or a malformed spec), or when it lists sections
 * and none validates: the turn then sends nothing, rather than clearing what
 * the model has on the strength of a bad spec. Otherwise each `{ key, markdown }`
 * with a known-shape key and non-blank text, first occurrence of a key only.
 */
export function validTurnContext(value: unknown): ChatTurnContextSection[] | null {
  if (!Array.isArray(value)) return null
  const sections: ChatTurnContextSection[] = []
  const keys = new Set<string>()
  for (const entry of value.slice(0, MAX_SECTIONS)) {
    if (!entry || typeof entry !== 'object') continue
    const { key, markdown } = entry as { key?: unknown; markdown?: unknown }
    if (typeof key !== 'string' || !KEY_RE.test(key) || keys.has(key)) continue
    if (typeof markdown !== 'string' || markdown.trim().length === 0) continue
    keys.add(key)
    const appendOnly = APPEND_ONLY.has(key) ? validAppendOnly(entry as { heading?: unknown; entries?: unknown }) : null
    sections.push(appendOnly ? { key, markdown, ...appendOnly } : { key, markdown })
  }
  return value.length > 0 && sections.length === 0 ? null : sections
}

/**
 * An append-only section's lines and heading, shape-guarded: each `{ id,
 * line }` with a well-formed id and a non-blank line, first occurrence of an
 * id only. Null when none validates: the section then rides as a plain one.
 */
function validAppendOnly(entry: { heading?: unknown; entries?: unknown }): Pick<ChatTurnContextSection, 'heading' | 'entries'> | null {
  if (!Array.isArray(entry.entries)) return null
  const entries: { id: string; line: string }[] = []
  const ids = new Set<string>()
  for (const item of entry.entries.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue
    const { id, line } = item as { id?: unknown; line?: unknown }
    if (typeof id !== 'string' || !ENTRY_ID_RE.test(id) || ids.has(id)) continue
    if (typeof line !== 'string' || line.trim().length === 0 || line.length > MAX_ENTRY_CHARS || line.includes('\n')) continue
    ids.add(id)
    entries.push({ id, line })
  }
  if (entries.length === 0) return null
  const heading =
    typeof entry.heading === 'string' && entry.heading.trim() && entry.heading.length <= MAX_ENTRY_CHARS && !entry.heading.includes('\n')
      ? entry.heading.trim()
      : undefined
  return { entries, ...(heading ? { heading } : {}) }
}

/** Whether line id `a` is past `b` (canonical decimals: longer is larger). */
function idAfter(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b
}

/** Replace the opening bracket of every turn-context or section tag look-alike in a body with `‹`. */
export function neutralizeTags(text: string): string {
  return text.replace(TAG_LOOKALIKE_RE, '‹')
}

/** A body's version: the first 12 hex digits of its SHA-256. */
function version(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12)
}

/** The text of a turn-context block eve holds in history, or null for any other message. */
function blockText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  // eve records a user-role instruction result as { role: 'user', kind:
  // 'context.instruction', content } (harness/messages.js). The user's own
  // messages are kind 'user', so a block they type is never read here.
  const { role, kind, content } = message as { role?: unknown; kind?: unknown; content?: unknown }
  if (role !== 'user' || kind !== 'context.instruction') return null
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
                ? String((part as { text?: unknown }).text ?? '')
                : '',
            )
            .join('')
        : ''
  return OPEN_RE.test(text) ? text : null
}

/**
 * Shape-guard a spec's `turnContextHeld`: the keys whose layer the turn asked
 * for and failed to load. Anything but a list of well-formed keys counts as none.
 */
export function validHeldKeys(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.slice(0, MAX_SECTIONS).filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)))
}

/**
 * A conservative token estimate of the history: its JSON, ASCII at four
 * characters a token and every other UTF-16 unit a token of its own. eve's
 * fallback (harness/token-estimate.js) is the JSON length over 4, but
 * JSON.stringify leaves non-ASCII unescaped, and CJK or other non-Latin text
 * runs near a token a character, so that would read 2 to 4 times low.
 */
export function estimateHistoryTokens(messages: readonly unknown[]): number {
  const json = JSON.stringify(messages) ?? ''
  let ascii = 0
  for (let i = 0; i < json.length; i++) if (json.charCodeAt(i) < 0x80) ascii++
  return ascii / 4 + (json.length - ascii)
}

/**
 * Whether the pre-turn history is close enough to eve's compaction threshold
 * that a model call in this turn may summarize the older blocks away. A
 * history-only proxy for eve's own check, which uses the provider-reported
 * input tokens of the last call (see the file header): estimateHistoryTokens,
 * against the threshold eve derives from the window the model resolver hands
 * it (the spec policy's window, capped by chatCompactionWindow exactly as
 * modelSelectionFromSpec caps it), less an allowance for the system prompt and
 * tools. Takes the policy's real window.
 */
export function nearCompaction(messages: readonly unknown[], contextWindowTokens?: number): boolean {
  const window = chatCompactionWindow(contextWindowTokens)
  const threshold = window
    ? Math.floor(window * EVE_COMPACTION_THRESHOLD_PERCENT)
    : EVE_DEFAULT_COMPACTION_THRESHOLD
  const budget = threshold - Math.min(ENVELOPE_ALLOWANCE_TOKENS, threshold / 2)
  let estimate: number
  try {
    estimate = estimateHistoryTokens(messages)
  } catch {
    return true
  }
  return estimate >= budget * RESEND_ALL_AT
}

/**
 * The latest version of each section the earlier blocks in `messages` sent:
 * its `v`, or null once a block marked it cleared. Keyed in the order the keys
 * were last mentioned. Reads only the opening tags.
 */
export function lastSentSections(messages: readonly unknown[]): Map<string, string | null> {
  const last = new Map<string, string | null>()
  for (const message of messages) {
    const text = blockText(message)
    if (text === null) continue
    for (const line of text.split('\n')) {
      const tag = OPENING_TAG_RE.exec(line)
      if (!tag) continue
      last.delete(tag[1])
      last.set(tag[1], tag[2] ?? null)
    }
  }
  return last
}

/**
 * The cursor of each append-only section: the `through` of the latest earlier
 * tag for its key that carries one. A later tag for the key without one (a
 * plain rendering, a clear) drops it, so everything goes out again. Reads only
 * the opening tags.
 */
export function lastSentCursors(messages: readonly unknown[]): Map<string, string> {
  const cursors = new Map<string, string>()
  for (const message of messages) {
    const text = blockText(message)
    if (text === null) continue
    for (const line of text.split('\n')) {
      const tag = OPENING_TAG_RE.exec(line)
      if (!tag) continue
      if (tag[3]) cursors.set(tag[1], tag[3])
      else cursors.delete(tag[1])
    }
  }
  return cursors
}

/**
 * Whether this is the first turn after a checkpoint, from the history alone:
 * the pre-turn history holds eve's `context.compaction` marker (a checkpoint
 * was made) and no turn-context block after it (no turn has run since). A
 * replay over the same history answers the same; once this turn's block lands
 * after the marker, every later turn answers false. Pure; never throws.
 */
export function firstTurnAfterCheckpoint(messages: readonly unknown[]): boolean {
  const list = Array.isArray(messages) ? messages : []
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] as { role?: unknown; kind?: unknown } | null
    if (m && typeof m === 'object' && m.role === 'user' && m.kind === 'context.compaction') {
      at = i
      break
    }
  }
  if (at < 0) return false
  for (let i = at + 1; i < list.length; i++) if (blockText(list[i]) !== null) return false
  return true
}

export type RenderTurnContextOptions = {
  /** Keys whose layer failed to load this turn: neither sent nor cleared. */
  held?: ReadonlySet<string>
  /** Send every present section, whatever the model has seen (nearCompaction). */
  resendAll?: boolean
  /** The append-only sections' cursors (lastSentCursors): only lines past them go out. */
  cursors?: ReadonlyMap<string, string>
  /** The first turn after a checkpoint (firstTurnAfterCheckpoint): the after-checkpoint sections go out. */
  afterCheckpoint?: boolean
}

/**
 * This turn's block: each section that differs from the version the model can
 * still see (and `time` always; every one with `resendAll`), then a `cleared`
 * marker for each key an earlier block sent that this turn no longer has and
 * does not hold. Null when there is nothing to send.
 */
export function renderTurnContext(
  sections: readonly ChatTurnContextSection[],
  last: ReadonlyMap<string, string | null>,
  options: RenderTurnContextOptions = {},
): string | null {
  const parts: string[] = []
  const present = new Set<string>()
  for (const section of sections) {
    present.add(section.key)
    if (AFTER_CHECKPOINT_ONLY.has(section.key)) {
      if (!options.afterCheckpoint) continue
      const body = neutralizeTags(section.markdown)
      parts.push(`<section key="${section.key}" v="${version(body)}">\n${body}\n</section>`)
      continue
    }
    if (APPEND_ONLY.has(section.key) && section.entries?.length) {
      const part = renderAppendOnly(section, section.entries, options.resendAll ? undefined : options.cursors?.get(section.key))
      if (part) parts.push(part)
      continue
    }
    const body = neutralizeTags(section.markdown)
    const v = version(body)
    if (!options.resendAll && !ALWAYS_SENT.has(section.key) && last.get(section.key) === v) continue
    parts.push(`<section key="${section.key}" v="${v}">\n${body}\n</section>`)
  }
  for (const [key, v] of last) {
    if (v !== null && !present.has(key) && !APPEND_ONLY.has(key) && !AFTER_CHECKPOINT_ONLY.has(key) && !neverCleared(key) && !options.held?.has(key)) {
      parts.push(`<section key="${key}" cleared="true"/>`)
    }
  }
  if (parts.length === 0) return null
  const inner = parts.join('\n')
  const id = version(inner)
  return `<turn-context id="${id}">\n${inner}\n</turn-context id="${id}">`
}

/**
 * An append-only section's part of the block: the lines past `cursor` (all of
 * them without one) under its heading, its tag carrying the new cursor. Null
 * when there is no new line.
 */
function renderAppendOnly(
  section: ChatTurnContextSection,
  entries: readonly { id: string; line: string }[],
  cursor: string | undefined,
): string | null {
  const fresh = cursor === undefined ? entries : entries.filter((e) => idAfter(e.id, cursor))
  if (fresh.length === 0) return null
  let through = cursor ?? fresh[0].id
  for (const e of fresh) if (idAfter(e.id, through)) through = e.id
  const body = neutralizeTags([section.heading ?? DEFAULT_APPEND_HEADING, ...fresh.map((e) => e.line)].join('\n'))
  return `<section key="${section.key}" v="${version(body)}" through="${through}">\n${body}\n</section>`
}
