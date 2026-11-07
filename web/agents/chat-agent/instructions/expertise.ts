/**
 * Loaded expertise packs, sent again near compaction (one-agent plan, Part 3).
 *
 * A pack goes in once per summary (../lib/context-reset.ts forgets the loaded
 * ones after one), on the tool result that first touched its area
 * (../lib/expertise.ts), and stays in the history after that, read
 * from the cache. Compaction would summarize it away like any older message,
 * so once the pre-turn history nears eve's compaction threshold this resolver
 * sends every loaded pack again as a user-role message at the turn's start:
 * the same rule, and the same history-only proxy (nearCompaction), as the
 * per-turn context in ./turn-context.ts, with the same gaps (a turn that
 * crosses the threshold inside its own tool loop waits for the next turn).
 *
 * Once per compaction cycle, not every turn: an area whose block a previous
 * resend already put in the history (a `context.instruction` message this
 * resolver wrote) is skipped. Compaction summarizes that message away with
 * the rest, and the area can go out again. Without this, every turn between
 * the mark and the threshold carried every pack again, and the extra tokens
 * pulled compaction closer.
 *
 * Which packs are loaded is the durable state the triggers write; their text
 * comes from the turn's one memoized spec fetch, so it adds no request. A pack
 * the spec no longer lists (its area switched off since) is not sent.
 *
 * Never throws: any failure sends nothing, and the history stands.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth, validModelPolicy } from '../lib/spec-client.js'
import { nearCompaction } from '../lib/turn-context.js'
import { loadedPackAreas, renderExpertiseBlock, validPacks } from '../lib/expertise.js'

/** A resend's opening tag for one area, as renderExpertiseBlock writes it. */
const RESENT_AREA_RE = /^<expertise area="([a-z][a-z_]{0,39})">$/gm

/** The text of a user-role instruction message eve holds in history, or ''. */
function instructionText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  // eve records a user-role instruction result as { role: 'user', kind:
  // 'context.instruction', content }. The user's own messages are kind
  // 'user', and tool results are never this kind, so only a resend counts.
  const { role, kind, content } = message as { role?: unknown; kind?: unknown; content?: unknown }
  if (role !== 'user' || kind !== 'context.instruction') return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/** The areas a previous resend already put in this history, since the last compaction. */
export function resentAreas(messages: readonly unknown[]): Set<string> {
  const areas = new Set<string>()
  for (const message of messages) {
    for (const match of instructionText(message).matchAll(RESENT_AREA_RE)) areas.add(match[1])
  }
  return areas
}

/** The resend's content for these loaded areas and this history, or null for none. */
export function expertiseResend(
  loaded: readonly string[],
  packsValue: unknown,
  messages: readonly unknown[],
  contextWindowTokens?: number,
): string | null {
  if (loaded.length === 0) return null
  if (!nearCompaction(messages, contextWindowTokens)) return null
  const already = resentAreas(messages)
  const packs = validPacks(packsValue).filter((p) => loaded.includes(p.area) && !already.has(p.area))
  if (packs.length === 0) return null
  return packs.map(renderExpertiseBlock).join('\n\n')
}

export default defineDynamic({
  events: {
    'turn.started': async (_event, ctx) => {
      try {
        const loaded = loadedPackAreas()
        if (loaded.length === 0) return null
        const spec = await fetchChatSpec(runTokenFromAuth(ctx.session.auth), turnCtxFromAuth(ctx.session.auth), { turnContext: true })
        const content = expertiseResend(loaded, spec?.packs, ctx.messages, validModelPolicy(spec?.modelPolicy)?.contextWindowTokens)
        return content ? defineInstructions({ content, role: 'user' }) : null
      } catch (err) {
        console.error(`[chat-agent] expertise resend skipped: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
  },
})
