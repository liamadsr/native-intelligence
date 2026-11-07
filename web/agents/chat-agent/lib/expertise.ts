/**
 * Expertise packs in the main chat (docs/plans/one-agent-and-chat-pages.md,
 * Part 3). One agent does everything; a pack is what it needs to be good at
 * one area: the area's playbook, its skills' one-line descriptions and what
 * it has learned about the person there (S2). The spec carries the packs this
 * conversation may load, already gated by the workspace's features and
 * rendered (src/lib/packs/chat-packs.ts).
 *
 * ── When a pack loads: code decides, once per conversation ──────────────────
 * A weak model can't be trusted to ask, so the pack rides the tool result
 * that first touches its area:
 *   - `search_tools` revealing one of its tools (Mail, CRM and every other
 *     non-core area are found this way before their tools can be called);
 *   - the first call of one of its tools (the core tools of Actions, Calendar
 *     and Captures, offered without a search);
 *   - `load_skill` of its playbook;
 *   - `show` with a card of its kind (attachCardExpertise, the seam P1's
 *     `show` calls).
 * Which areas are loaded lives in durable state (`loadedPacks`), as the
 * discovered tools do, so a replayed or resumed step never sends one twice.
 *
 * ── Who sees it ─────────────────────────────────────────────────────────────
 * Only the model. The execute puts the fenced blocks under EXPERTISE_FIELD on
 * its output; the proxy's `toModelOutput` (expertiseModelOutput) takes them
 * off the JSON and hands them to the model as text after it. The full output
 * still reaches the browser on action.result, so the chat transport drops the
 * field before the part is drawn or saved
 * (src/lib/chat/eve/eve-chat-transport.ts stripModelOnlyToolFields).
 *
 * ── Compaction ──────────────────────────────────────────────────────────────
 * A loaded pack stays in the history, cached. Near eve's compaction threshold
 * the expertise instructions resolver (../instructions/expertise.ts) sends
 * every loaded pack again, the rule the per-turn context follows. Once a
 * summary has replaced the older history, the next turn forgets which packs
 * were loaded (./context-reset.ts), so a pack goes in once per summary, not
 * once per conversation.
 */
import { defineState } from 'eve/context'
import { toolOutput, toolOutputPart, type ToolModelOutput } from 'eve/tools'
import { fetchChatSpec } from './spec-client.js'
import { capToolModelOutput } from './model-output-cap.js'

/** The output field the expertise blocks ride. Mirrored in eve-chat-transport.ts (expertise-drift.test.ts). */
export const EXPERTISE_FIELD = '__expertise'

/** A pack on the spec wire. Mirrors ChatPack in src/lib/packs/chat-packs.ts. */
export interface ChatPack {
  area: string
  name: string
  playbookSkill: string | null
  toolNames: string[]
  cardKinds: string[]
  markdown: string
}

/** One fenced block as it rides a tool output. */
export interface ExpertiseBlock {
  area: string
  text: string
}

/** A search result attaches at most this many packs; the rest load on their first tool call. */
export const MAX_PACKS_PER_RESULT = 2

const AREA_RE = /^[a-z][a-z_]{0,39}$/

/** The areas this conversation has loaded. Durable: survives steps, replays and crashes. */
const loadedPacks = defineState<string[]>('chat-agent.loaded-packs', () => [])

/** The loaded areas, as durable state has them. */
export function loadedPackAreas(): string[] {
  return loadedPacks.get()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Shape-guard a spec's `packs`. A malformed entry is dropped; an app that
 * predates packs sends none, and nothing loads.
 */
export function validPacks(value: unknown): ChatPack[] {
  if (!Array.isArray(value)) return []
  const out: ChatPack[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const { area, name, playbookSkill, markdown } = entry
    if (typeof area !== 'string' || !AREA_RE.test(area) || out.some((p) => p.area === area)) continue
    if (typeof markdown !== 'string' || markdown.trim().length === 0) continue
    out.push({
      area,
      name: typeof name === 'string' ? name : area,
      playbookSkill: typeof playbookSkill === 'string' && playbookSkill ? playbookSkill : null,
      toolNames: stringList(entry.toolNames),
      cardKinds: stringList(entry.cardKinds),
      markdown,
    })
  }
  return out
}

/** The pack a tool belongs to, or null. */
export function packForTool(name: string, packs: readonly ChatPack[]): ChatPack | null {
  return packs.find((p) => p.toolNames.includes(name)) ?? null
}

/** The packs some tools reveal, in the order their tools rank, at most `max`. */
export function packsForTools(names: readonly string[], packs: readonly ChatPack[], max = MAX_PACKS_PER_RESULT): ChatPack[] {
  const out: ChatPack[] = []
  for (const name of names) {
    const pack = packForTool(name, packs)
    if (pack && !out.includes(pack)) out.push(pack)
    if (out.length >= max) break
  }
  return out
}

/** The pack whose playbook a skill name is, or null. */
export function packForPlaybook(skillName: string, packs: readonly ChatPack[]): ChatPack | null {
  return packs.find((p) => p.playbookSkill === skillName) ?? null
}

/** A card as `show` describes it, as far as its area goes. */
export interface CardRef {
  kind: string
  entity_type?: string | null
  record_type?: string | null
}

/**
 * The card a `show` result drew, as packForCard reads it: a list card names
 * its `entity_type`, a record card its `record.type`
 * (src/lib/chat-cards/kinds.ts CardSpec). Null when the call drew no card
 * (a refusal), so a failed show loads nothing.
 */
export function cardRefOf(output: unknown): CardRef | null {
  if (!isRecord(output) || output.success !== true || !isRecord(output.card)) return null
  const card = output.card
  if (typeof card.kind !== 'string') return null
  if (card.kind === 'record') {
    const type = isRecord(card.record) && typeof card.record.type === 'string' ? card.record.type : null
    return { kind: 'record', record_type: type }
  }
  return { kind: card.kind, entity_type: typeof card.entity_type === 'string' ? card.entity_type : null }
}

/** The pack a card belongs to: its `kind:type` first, then its bare kind. Null for none. */
export function packForCard(card: CardRef, packs: readonly ChatPack[]): ChatPack | null {
  const type = card.kind === 'record' ? card.record_type : card.entity_type
  if (type) {
    const typed = packs.find((p) => p.cardKinds.includes(`${card.kind}:${type}`))
    if (typed) return typed
  }
  return packs.find((p) => p.cardKinds.includes(card.kind)) ?? null
}

/**
 * Mark packs loaded and return the ones that weren't yet: the only ones to
 * send. `force` returns them all (an explicit load_skill of a playbook) while
 * still recording them.
 */
export function claimPacks(packs: readonly ChatPack[], force = false): ChatPack[] {
  if (packs.length === 0) return []
  const before = new Set(loadedPacks.get())
  const fresh = force ? [...packs] : packs.filter((p) => !before.has(p.area))
  if (packs.some((p) => !before.has(p.area))) {
    loadedPacks.update((prev) => {
      const set = new Set(prev)
      for (const p of packs) set.add(p.area)
      return [...set]
    })
  }
  return fresh
}

/**
 * Forget the loaded packs: their text rode tool results the session has since
 * summarized away (./context-reset.ts), so the next time the agent opens an
 * area its pack comes with it again.
 */
export function resetLoadedPacks(): void {
  loadedPacks.update(() => [])
}

/** The packs' version the session's loaded packs were claimed under (spec.packsVersion); null before any. */
const packsVersion = defineState<string | null>('chat-agent.packs-version', () => null)

/**
 * A spec whose packs' text changed since this session loaded them (a deploy:
 * spec.packsVersion, src/lib/packs/chat-packs.ts PACKS_VERSION) forgets the
 * loaded packs, the reset a summary makes (./context-reset.ts), so the next
 * touch of an area brings its new text instead of the old one the history
 * holds. A session that has none recorded yet (one from before versions) resets
 * too. True when it reset. Never throws.
 */
export function resetPacksOnNewVersion(version: unknown): boolean {
  if (typeof version !== 'string' || !version) return false
  try {
    if (packsVersion.get() === version) return false
    packsVersion.update(() => version)
    if (loadedPacks.get().length === 0) return false
    resetLoadedPacks()
    return true
  } catch (err) {
    console.error(`[chat-agent] packs version check failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * An `<expertise>` look-alike's opening bracket, in any case or spacing, as
 * an ASCII or fullwidth bracket or its entity. A pack body quotes text a
 * member wrote (a skill's description, later a memory line), so it can't be
 * allowed to close its own fence.
 */
const FENCE_LOOKALIKE_RE = /(?:<|＜|﹤|&lt;?|&#0*60;?|&#x0*3c;?)(?=[\s\p{Cf}]*[/／]?[\s\p{Cf}]*expertise(?![a-z0-9]))/giu

/** The fenced block the model reads for one pack. */
export function renderExpertiseBlock(pack: ChatPack): string {
  const body = pack.markdown.replace(FENCE_LOOKALIKE_RE, '‹')
  return `<expertise area="${pack.area}">\n${body}\n</expertise>`
}

/**
 * An execute's output with the packs' blocks attached under EXPERTISE_FIELD.
 * A non-object output (a bare string or list) is wrapped as `{ result }` so the
 * field has somewhere to live; no packs, and the output is returned as is.
 */
export function attachExpertise(output: unknown, packs: readonly ChatPack[]): unknown {
  if (packs.length === 0) return output
  const blocks: ExpertiseBlock[] = packs.map((p) => ({ area: p.area, text: renderExpertiseBlock(p) }))
  const base = isRecord(output) ? output : { result: output ?? null }
  const prior = Array.isArray(base[EXPERTISE_FIELD]) ? (base[EXPERTISE_FIELD] as ExpertiseBlock[]) : []
  return { ...base, [EXPERTISE_FIELD]: [...prior, ...blocks] }
}

/** The blocks an output carries, and the output without them. */
export function splitExpertise(output: unknown): { rest: unknown; blocks: ExpertiseBlock[] } {
  if (!isRecord(output) || !(EXPERTISE_FIELD in output)) return { rest: output, blocks: [] }
  const { [EXPERTISE_FIELD]: raw, ...rest } = output
  const blocks = Array.isArray(raw)
    ? raw.filter((b): b is ExpertiseBlock => isRecord(b) && typeof b.area === 'string' && typeof b.text === 'string')
    : []
  return { rest, blocks }
}

/**
 * What the model sees of a result that may carry expertise: the result as the
 * tool's own projection makes it (`base`, JSON by default), then each block as
 * text. A result without blocks is exactly what `base` makes of it.
 */
export function expertiseModelOutput(output: unknown, base?: (rest: unknown) => ToolModelOutput): ToolModelOutput {
  const { rest, blocks } = splitExpertise(output)
  // The result itself is capped (lib/model-output-cap.ts); a pack after it never is.
  const projected = capToolModelOutput(base ? base(rest) : toolOutput.json(rest ?? null))
  if (blocks.length === 0) return projected
  const texts = blocks.map((b) => b.text)
  if (projected.type === 'content') {
    return toolOutput.content([...projected.value, ...texts.map((t) => toolOutputPart.text(t))])
  }
  const head = projected.type === 'text' ? projected.value : JSON.stringify(projected.value ?? null)
  return toolOutput.text([head, ...texts].join('\n\n'))
}

/**
 * Attach the pack of `area` to an output if this conversation hasn't loaded
 * it yet. Reads the turn's memoized spec, so it costs no request in practice.
 * Never throws: a pack that can't load leaves the output as it was.
 */
export async function attachAreaExpertise(
  output: unknown,
  area: string,
  runToken: string,
  turnCtx: string,
): Promise<unknown> {
  if (!area || loadedPacks.get().includes(area)) return output
  try {
    const spec = await fetchChatSpec(runToken, turnCtx)
    const pack = validPacks(spec?.packs).find((p) => p.area === area)
    return pack ? attachExpertise(output, claimPacks([pack])) : output
  } catch {
    return output
  }
}

/**
 * The `show` seam: attach the pack of a card's area to `show`'s output the
 * first time the agent shows a card of that kind. The `show` proxy
 * (../tools/workspace_tools.ts) calls it with the card its result drew
 * (cardRefOf).
 */
export async function attachCardExpertise(
  output: unknown,
  card: CardRef,
  runToken: string,
  turnCtx: string,
): Promise<unknown> {
  try {
    const spec = await fetchChatSpec(runToken, turnCtx)
    const pack = packForCard(card, validPacks(spec?.packs))
    return pack ? attachExpertise(output, claimPacks([pack])) : output
  } catch {
    return output
  }
}
