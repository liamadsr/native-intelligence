/**
 * What a parked connector step's approval card says (F4,
 * docs/plans/flows-connectors.md §2.3): exactly what will happen, in one
 * line, from the call itself, never from a model:
 *   "Post via Typefully: '…'", "Add to Typefully queue: next free slot",
 *   "Comment on LIN-42: '…'", "Run append_block on Notion?".
 * The card shows every input under it (ApprovalInputs), so the line is a
 * summary, never the only record. Quoted text is the call's own input,
 * clipped. Pure and client-safe.
 */
import { inputPublishes, isPublishKey, nameWords } from '@/lib/mcp-client/input-policy'

/** The most of a quoted text the title carries. */
const QUOTE_MAX = 80

/** Keys whose string value is the text a post or comment carries. */
const TEXT_KEYS = ['text', 'content', 'body', 'message', 'comment', 'draft', 'post', 'tweet', 'markdown', 'value']
/** Keys that name an account a post goes out as. */
const HANDLE_KEYS = ['handle', 'username', 'account', 'account_handle', 'screen_name']
/** An issue key like LIN-42 or ENG-7. */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1)}…` : one
}

/** The first text-shaped value in the input (deep, in key order: text, content, …). */
export function quotedText(input: unknown, depth = 0): string | null {
  if (depth > 6 || !input || typeof input !== 'object') return null
  if (Array.isArray(input)) {
    for (const v of input) {
      const t = quotedText(v, depth + 1)
      if (t) return t
    }
    return null
  }
  const obj = input as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  for (const v of Object.values(obj)) {
    const t = quotedText(v, depth + 1)
    if (t) return t
  }
  return null
}

function handleOf(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  for (const key of HANDLE_KEYS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && /^@?[A-Za-z0-9_.-]{1,40}$/.test(v.trim())) return v.trim().startsWith('@') ? v.trim() : `@${v.trim()}`
  }
  return null
}

function issueKeyOf(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (typeof v === 'string' && ISSUE_KEY_RE.test(v.trim())) return v.trim()
  }
  return null
}

/** The publish-shaped value the input sets (publish_at: "next-free-slot", a time, true), if any. */
function publishValue(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isPublishKey(k) && v !== null && v !== undefined && v !== false && v !== '') return v
  }
  return undefined
}

/** When a publish value is a time, the card says it as the call holds it (an ISO string stays readable). */
function whenOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/next[-_ ]?free[-_ ]?slot|^queue$/i.test(value)) return 'next free slot'
  if (/^now$/i.test(value)) return 'now'
  return Number.isFinite(Date.parse(value)) ? value : null
}

export interface ConnectorCardInput {
  serverName: string
  /** The server's own tool name. */
  tool: string
  input: unknown
  /** The loop's name, for the why line. */
  flowName?: string | null
  /** The call publishes or reaches people (input-policy.ts): the why line says so. */
  publicContent?: boolean
}

/** A character count as a short phrase: 940 chars, 2.1k chars. */
function chars(n: number): string {
  return n < 1000 ? `${n} char${n === 1 ? '' : 's'}` : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k chars`
}

/**
 * The line a connector step leaves on flow_run (readable by every member of
 * the workspace): what happened, never the call's input or the app's text
 * ("Read 2.1k chars from Notion", "Posted to Typefully" is the card's own).
 */
export function connectorRunLine(args: { serverName: string; tool: string; chars?: number; inert?: boolean; publicContent?: boolean }): string {
  if (args.chars !== undefined) {
    return args.inert
      ? `Ran ${args.tool} on ${args.serverName} without a card (it publishes nothing); ${chars(args.chars)} back`
      : `Read ${chars(args.chars)} from ${args.serverName} (${args.tool})`
  }
  return args.publicContent ? `a post via ${args.serverName} (${args.tool})` : `${args.tool} on ${args.serverName}`
}

/** The card's title and why, for one parked connector step. Pure. */
export function connectorCardCopy(args: ConnectorCardInput): { title: string; why: string } {
  const { serverName, tool, input } = args
  const words = nameWords(tool)
  const text = quotedText(input)
  const quote = text ? `: '${clip(text)}'` : ''
  const as = handleOf(input)
  let title: string
  const publishes = inputPublishes(input)
  const when = whenOf(publishValue(input))
  if (publishes && when === 'next free slot') {
    title = `Add to ${serverName} queue: next free slot${quote}`
  } else if (publishes && when && when !== 'now') {
    title = `Schedule on ${serverName} for ${when}${quote}`
  } else if (publishes || words.some((w) => ['publish', 'post', 'tweet', 'share', 'broadcast'].includes(w))) {
    title = `Post via ${serverName}${as ? ` as ${as}` : ''}${quote}`
  } else if (words.some((w) => w === 'comment' || w === 'reply')) {
    const key = issueKeyOf(input)
    title = `${words.includes('reply') ? 'Reply' : 'Comment'}${key ? ` on ${key}` : ` in ${serverName}`}${quote}`
  } else if (words.some((w) => w === 'send' || w === 'message' || w === 'email' || w === 'dm')) {
    title = `Send via ${serverName}${quote}`
  } else {
    title = `Run ${tool} on ${serverName}?`
  }
  const loop = args.flowName ? `“${args.flowName}”` : 'A loop'
  const publicLine = args.publicContent ? ' This posts publicly.' : ''
  const why = `${loop} stopped here for your yes.${publicLine} It runs once, as you, with exactly the inputs below, and the loop carries on from this step. Edit them first, or skip it and the run ends here.`
  return { title: title.slice(0, 200), why: why.slice(0, 500) }
}
