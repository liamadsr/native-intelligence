/**
 * Input-aware approval for a connected app's tool, on a flow's unattended
 * steps (F4; pattern P7 in docs/plans/eve-templates-lessons.md §3b: "approval
 * reads the input, not just the tool name"; decision 24 in eve-alignment.md).
 *
 * P5's policy (approval-policy.ts mcpToolRequiresApproval) answers per TOOL:
 * a write asks, a read runs, and a catalog app that publishes (Typefully)
 * asks on every tool that is not a plain read. This reads the CALL too, and
 * answers one of:
 *   read   it runs (a read; or a tool the person made approval-free, unless
 *          a rule below says otherwise);
 *   inert  it runs without a card and is reported in the run's summary and
 *          digest: a write that provably changes nothing anyone else sees;
 *   ask    the run parks on the owner's approval card.
 *
 * The rules, in order (connectorCallPolicy):
 *   1. PUBLIC CONTENT ALWAYS ASKS (decision 2, "user always approves"), a hard
 *      rule no trust, setting or approval-free choice relaxes: any tool that
 *      is not a plain read and whose name publishes, posts, shares, sends,
 *      replies, comments, submits, schedules, queues, pins or forwards (or
 *      updates a status); any call whose input carries a publish-shaped field
 *      with a value (a `publish_at`, a `schedule`, `publish: true`); any call
 *      that sets a status or visibility to published, public or scheduled.
 *   2. A DELETE ALWAYS ASKS (decision 4: anything that publishes, sends or
 *      deletes always takes a card): a tool that is not a plain read and has
 *      the server's destructiveHint, or a name that deletes, removes,
 *      archives, destroys or cancels; or any call whose input sets a delete
 *      flag (archived, in_trash, trashed, deleted, is_deleted: true).
 *      Whatever the approval-free list says.
 *   3. The person's own "ask first" (require_approval_tools) wins over every
 *      connector rule below.
 *   4. Once the run has read outside text (outside-text.ts, the one notion),
 *      a call that could carry it out asks: any server outside the catalog,
 *      or any call whose input has a URL in it (a url-shaped key or value).
 *      GitHub's read-only endpoint (github-server.ts: the person's GitHub
 *      integration) counts as in the catalog here: a read of their own
 *      GitHub sends nothing anywhere, so a loop or skill run can read a PR
 *      after reading another. A URL in its input still asks.
 *   5. Per connector, in code (CONNECTOR_RULES, keyed by catalog id; one rule
 *      today):
 *        typefully: a CREATE of a draft whose input proves it cannot publish
 *        is inert. Proves means, failing closed:
 *          - the tool's name says create (create / new / save / add) and
 *            draft, and nothing else that acts (no edit, update, delete,
 *            publish, schedule…): an edit of an already-scheduled draft
 *            would change what goes out, so it asks;
 *          - EVERY key of the input, at every depth, is a draft-content key
 *            (DRAFT_CONTENT_KEYS: its text, title, tags, platforms and their
 *            posts, notes); a `status`, a `when`, any unknown key asks;
 *          - the input has NO publish-shaped key anywhere, whatever its
 *            value (not even `publish_at: null`);
 *          - the tool's own input schema is known and gives no
 *            publish-shaped property a default anywhere (a default would
 *            publish when the key is left out).
 *        Anything nested past the readers' depth is not proven: it asks.
 *        Anything else on Typefully asks (P5 already asks on every
 *        non-read Typefully tool; this relaxes only the proven case).
 *   6. Any other call: P5's tool-level answer (requiresApproval → ask,
 *      else read). An unknown server's hints are never trusted there either.
 *
 * Pure, no server imports: safe in client code (the card copy reads it).
 */
import { isPlainReadForUnknownServer, type McpToolForPolicy } from './approval-policy'
import { suggestedMcpServerFor } from './suggested'
import { isGitHubReadOnlyServerUrl } from './github-server'

export type ConnectorCallPolicy = 'read' | 'inert' | 'ask'

export interface ConnectorCallCheck {
  /** The server's URL: the connector rules are keyed by the catalog entry it belongs to. */
  serverUrl: string | null | undefined
  /** The tool as the server lists it (name, hints, input schema). */
  tool: McpToolForPolicy & { inputSchema?: Record<string, unknown> | null }
  /** The exact input the call would run with (rendered). */
  input: unknown
  /** P5's tool-level answer for this tool on this server (mcpToolRequiresApproval). */
  requiresApproval: boolean
  /**
   * The person listed this tool in the server's require_approval_tools: their
   * explicit "ask first". It wins over every connector rule (rule 3).
   */
  explicitlyRequired?: boolean
  /**
   * The run has already read outside text (outside-text.ts, the one notion).
   * A call that could carry it out (rule 4) then asks.
   */
  readOutsideText?: boolean
}

export type ConnectorCallRule =
  | 'public_content'
  | 'destructive'
  | 'explicit'
  | 'outside_egress'
  | 'typefully_draft'
  | 'connector'
  | 'tool_level'

export interface ConnectorCallDecision {
  policy: ConnectorCallPolicy
  /** Which rule decided. */
  rule: ConnectorCallRule
  /** True when the call publishes or reaches people: the card can never be skipped. */
  publicContent: boolean
  /** One plain line for the run's history ("Saved a draft: no publish time"). */
  reason: string
}

/** A tool name as lower-case words, in any naming style (createDraft, create_draft, create-draft). */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** How deep the readers look. Anything deeper is "not proven": it asks. */
const MAX_DEPTH = 12

/** Words in a tool's name that publish or reach people. */
const PUBLIC_VERBS: ReadonlySet<string> = new Set([
  'publish', 'publishes', 'post', 'posts', 'repost', 'tweet', 'retweet', 'share', 'broadcast', 'send', 'reply',
  'comment', 'schedule', 'scheduled', 'queue', 'enqueue', 'announce', 'message', 'dm', 'invite', 'notify', 'email',
  'submit', 'toot', 'cast', 'pin', 'forward',
])
/** Word pairs in a tool's name that publish (update_status, setStatus). */
const PUBLIC_PHRASES: ReadonlyArray<readonly [string, string]> = [['update', 'status'], ['set', 'status'], ['post', 'status']]

/** Words in a tool's name that delete or undo something: always the person's card. */
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  'delete', 'remove', 'archive', 'destroy', 'cancel', 'purge', 'erase', 'wipe', 'drop', 'trash', 'revoke', 'unpublish', 'clear',
])

/** A key that would make a call publish, schedule, share or send (in any naming style). */
const PUBLISH_KEY_RE = /publish|schedul|share|queue|slot|send|go_?live|post_?(at|now|time|date|on)|auto_?(post|retweet|plug|publish)|release_?(at|date)/i
/** A status or visibility key... */
const STATUS_KEY_RE = /^(status|state|visibility|privacy|audience)$/i
/** ...whose value makes it public. */
const PUBLIC_VALUE_RE = /^(publish(ed)?|public|schedul(e|ed)|live|posted|everyone|anyone)$/i
/** A key that names somewhere to send things, and a value that is a URL. */
const URL_KEY_RE = /(^|_)(url|uri|urls|uris|href|link|links|endpoint|webhook|callback|redirect)(_|$)/i
const URL_VALUE_RE = /^\s*[a-z][a-z0-9+.-]*:\/\//i

/** A key in snake form (publishAt → publish_At), for the key patterns. */
function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
}

/** True when the key names a publish-shaped field. */
export function isPublishKey(key: string): boolean {
  return PUBLISH_KEY_RE.test(snake(key))
}

/** A value that sets something (not empty, not false, not null). */
function setsSomething(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

/**
 * Visit every key in a JSON value (deep), with its value. `state.tooDeep` is
 * set when the value nests past MAX_DEPTH: the caller reads that as "not
 * proven", which asks.
 */
function walk(value: unknown, visit: (key: string, v: unknown) => void, state: { tooDeep: boolean }, depth = 0): void {
  if (!value || typeof value !== 'object') return
  if (depth > MAX_DEPTH) {
    state.tooDeep = true
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, state, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    visit(k, v)
    walk(v, visit, state, depth + 1)
  }
}

/**
 * The input publishes (rule 1): a publish-shaped field with a value, or a
 * status or visibility set to public. Too deep to read: it does.
 */
export function inputPublishes(input: unknown): boolean {
  const state = { tooDeep: false }
  let hit = false
  walk(input, (k, v) => {
    if (isPublishKey(k) && setsSomething(v)) hit = true
    if (STATUS_KEY_RE.test(k) && typeof v === 'string' && PUBLIC_VALUE_RE.test(v.trim())) hit = true
  }, state)
  return hit || state.tooDeep
}

/** The input has no publish-shaped key at all, whatever its value (fail closed: too deep is not proven). */
export function inputHasNoPublishKey(input: unknown): boolean {
  const state = { tooDeep: false }
  let hit = false
  walk(input, (k) => {
    if (isPublishKey(k)) hit = true
  }, state)
  return !hit && !state.tooDeep
}

/** The input names somewhere to send things: a url-shaped key, or a value that is a URL (rule 4). Too deep: it does. */
export function inputHasUrl(input: unknown): boolean {
  const state = { tooDeep: false }
  // A string, or a string inside (nested) arrays: walk only visits object
  // entries, so `{ targets: ["https://…"] }` is read here. Objects inside
  // arrays are walked as usual; past MAX_DEPTH walk flags tooDeep.
  const urlIn = (v: unknown, depth = 0): boolean =>
    Array.isArray(v) ? depth <= MAX_DEPTH && v.some((x) => urlIn(x, depth + 1)) : typeof v === 'string' && URL_VALUE_RE.test(v)
  let hit = urlIn(input)
  walk(input, (k, v) => {
    if (URL_KEY_RE.test(snake(k))) hit = true
    if (urlIn(v)) hit = true
  }, state)
  return hit || state.tooDeep
}

/**
 * The keys a Typefully draft may carry and still be proven inert: its text,
 * title, tags, the platforms it is written for and their posts, notes. ANY
 * other key anywhere (a status, a `when`, a date, an unknown field) is not
 * proven.
 */
export const DRAFT_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content', 'text', 'draft_title', 'title', 'tags', 'platforms', 'posts', 'scratchpad', 'scratchpad_text', 'notes',
  'social_set_id', 'x', 'linkedin', 'threads', 'bluesky', 'mastodon', 'enabled', 'media_ids',
])

/** Every key of the input, at every depth, is a draft-content key (fail closed: too deep is not proven). */
export function inputOnlyDraftContent(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const state = { tooDeep: false }
  let stray = false
  walk(input, (k) => {
    if (!DRAFT_CONTENT_KEYS.has(snake(k).toLowerCase())) stray = true
  }, state)
  return !stray && !state.tooDeep
}

/**
 * A schema gives some publish-shaped property a default, anywhere it could
 * apply: properties and patternProperties, items and prefixItems,
 * additionalProperties, the combinators (anyOf/oneOf/allOf/not), if/then/else,
 * and definitions. Nested past the readers' depth counts as yes (not proven).
 */
export function schemaDefaultsPublish(schema: unknown, depth = 0, root: unknown = schema): boolean {
  if (!schema || typeof schema !== 'object') return false
  if (depth > MAX_DEPTH) return true
  const s = schema as Record<string, unknown>
  const recurse = (x: unknown) => schemaDefaultsPublish(x, depth + 1, root)
  // A $ref: a local one into this schema's own $defs/definitions is read there
  // (below, from the root); any other, or one that doesn't resolve, is not proven.
  if (s.$ref !== undefined && !resolvesLocally(s.$ref, root)) return true
  for (const mapKey of ['properties', 'patternProperties']) {
    const props = s[mapKey] && typeof s[mapKey] === 'object' ? (s[mapKey] as Record<string, unknown>) : {}
    for (const [k, v] of Object.entries(props)) {
      if (isPublishKey(k) && v && typeof v === 'object' && Object.hasOwn(v as object, 'default')) return true
      if (recurse(v)) return true
    }
  }
  for (const key of ['items', 'additionalProperties', 'if', 'then', 'else', 'not', 'contains', 'propertyNames']) {
    const sub = s[key]
    if (Array.isArray(sub) ? sub.some(recurse) : !!sub && typeof sub === 'object' && recurse(sub)) return true
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const sub = s[key]
    if (Array.isArray(sub) && sub.some(recurse)) return true
  }
  for (const key of ['$defs', 'definitions', 'dependentSchemas']) {
    const sub = s[key]
    if (sub && typeof sub === 'object' && Object.values(sub as Record<string, unknown>).some(recurse)) return true
  }
  return false
}

/** A `#/$defs/x` or `#/definitions/x` reference that names an entry of the root schema. */
function resolvesLocally(ref: unknown, root: unknown): boolean {
  if (typeof ref !== 'string' || !root || typeof root !== 'object') return false
  const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref)
  if (!m) return false
  const defs = (root as Record<string, unknown>)[m[1]]
  // The ref comes from a third-party server's schema: a malformed escape
  // (`%E0%A4%A`) throws URIError. It resolves nowhere, so it is not proven.
  let name: string
  try {
    name = decodeURIComponent(m[2])
  } catch {
    return false
  }
  return !!defs && typeof defs === 'object' && Object.hasOwn(defs as object, name.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** Keys that, set true, delete or trash the thing a call updates (update_page {archived: true}). */
const DELETE_FLAG_RE = /^(archived|is_archived|in_trash|trashed|is_trashed|deleted|is_deleted)$/i

/** The input deletes through a flag (archived, in_trash, deleted… set true). Too deep to read: it may. */
export function inputDeletes(input: unknown): boolean {
  const state = { tooDeep: false }
  let hit = false
  walk(input, (k, v) => {
    if (DELETE_FLAG_RE.test(snake(k)) && (v === true || v === 'true')) hit = true
  }, state)
  return hit || state.tooDeep
}

/** The tool's name publishes or reaches people (and it is not a plain read). */
export function toolNamePublishes(tool: McpToolForPolicy): boolean {
  if (isPlainReadForUnknownServer(tool)) return false
  const words = nameWords(tool.name)
  if (words.some((w) => PUBLIC_VERBS.has(w))) return true
  return PUBLIC_PHRASES.some(([a, b]) => words.includes(a) && words.includes(b))
}

/** Rule 1: posts and public content. */
export function isPublicContentCall(tool: McpToolForPolicy, input: unknown): boolean {
  return toolNamePublishes(tool) || inputPublishes(input)
}

/** Rule 2: a tool that deletes or undoes something (its own hint, or its name), unless it is a plain read. */
export function isDestructiveTool(tool: McpToolForPolicy): boolean {
  if (isPlainReadForUnknownServer(tool)) return false
  if (tool.annotations?.destructiveHint === true) return true
  return nameWords(tool.name).some((w) => DESTRUCTIVE_VERBS.has(w))
}

const CREATE_WORDS: ReadonlySet<string> = new Set(['create', 'new', 'save', 'add'])
/** Any of these in a draft tool's name and it is not a plain create. */
const ACTING_WORDS: ReadonlySet<string> = new Set([
  'edit', 'update', 'modify', 'patch', 'replace', 'move', 'duplicate', 'copy', 'convert', 'set', 'status',
  ...DESTRUCTIVE_VERBS,
  ...PUBLIC_VERBS,
])

/** A tool whose name is a draft create and nothing else (createDraft, create_draft, save-draft). */
export function isDraftCreateName(name: string): boolean {
  const words = nameWords(name)
  if (!words.some((w) => w === 'draft' || w === 'drafts')) return false
  if (!words.some((w) => CREATE_WORDS.has(w))) return false
  return !words.some((w) => ACTING_WORDS.has(w))
}

type ConnectorRule = (check: ConnectorCallCheck) => ConnectorCallDecision | null

/** Per-connector rules, keyed by catalog id (suggested.ts). Each may answer, or pass (null). */
export const CONNECTOR_RULES: Readonly<Record<string, ConnectorRule>> = Object.freeze({
  typefully: (check) => {
    if (isPlainReadForUnknownServer(check.tool)) return null
    const schema = check.tool.inputSchema
    const proven =
      isDraftCreateName(check.tool.name) &&
      inputOnlyDraftContent(check.input) &&
      inputHasNoPublishKey(check.input) &&
      !!schema && typeof schema === 'object' && Object.keys(schema).length > 0 &&
      !schemaDefaultsPublish(schema)
    if (proven) {
      return { policy: 'inert', rule: 'typefully_draft', publicContent: false, reason: 'Saved as a Typefully draft with no publish time, so it ran without a card' }
    }
    return { policy: 'ask', rule: 'connector', publicContent: false, reason: 'Typefully can publish, so this waits for your approval' }
  },
})

/** The catalog id a server URL belongs to, if any. */
function catalogIdOf(serverUrl: string | null | undefined): string | null {
  return serverUrl ? (suggestedMcpServerFor(serverUrl)?.id ?? null) : null
}

/**
 * The one answer for a flow step's call on a connected app (the header has
 * the rules, in this order). Fails closed: anything it can't prove harmless
 * asks.
 */
export function connectorCallPolicy(check: ConnectorCallCheck): ConnectorCallDecision {
  if (isPublicContentCall(check.tool, check.input)) {
    return { policy: 'ask', rule: 'public_content', publicContent: true, reason: 'It publishes or reaches people, which always takes your approval' }
  }
  if (isDestructiveTool(check.tool) || (!isPlainReadForUnknownServer(check.tool) && inputDeletes(check.input))) {
    return { policy: 'ask', rule: 'destructive', publicContent: false, reason: 'It deletes or undoes something, which always takes your approval' }
  }
  if (check.explicitlyRequired === true) {
    return { policy: 'ask', rule: 'explicit', publicContent: false, reason: 'You set this tool to ask first' }
  }
  const id = catalogIdOf(check.serverUrl)
  const trusted = !!id || isGitHubReadOnlyServerUrl(check.serverUrl)
  if (check.readOutsideText === true && (!trusted || inputHasUrl(check.input))) {
    return { policy: 'ask', rule: 'outside_egress', publicContent: false, reason: 'This run read outside text, and this call could send it on, so it waits for your approval' }
  }
  const rule = id ? CONNECTOR_RULES[id] : undefined
  const ruled = rule ? rule(check) : null
  if (ruled) return ruled
  return check.requiresApproval
    ? { policy: 'ask', rule: 'tool_level', publicContent: false, reason: 'It changes something in the app, so it waits for your approval' }
    : { policy: 'read', rule: 'tool_level', publicContent: false, reason: 'A read' }
}
