// Judging and making sounds (sound-contract.ts: `sound-judge`, `sound-make`), the agent's ears and its sound maker.
// The work runs in the Studio worker with earshot; this module checks what is asked, queues it and files what comes
// back.
//
//   judge  library audio and bank sounds heard: describe (and a match against a description), measure, compare, rank,
//          find (best moments in one sound, or the bank's best for a description), an A/B, realness. Nothing is written
//          but the job: its result is compact numbers and short words (judgeResultFrom), checked again here.
//   make   forge: a new sound made in code toward a description (a recipe searched by earshot's critic), one to four
//          candidates. fit: a library recording turned into code and rendered again. Each made sound is checked
//          against what the job stored (ownAsset) and registered in the library with its provenance. It is never
//          placed on a video: the agent places one with import_studio_sound once it has ranked the candidates.
import { EditorAssetSchema, type EditorAsset } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { getAsset, registerAsset } from './assets'
import { requireCapability } from './capabilities'
import type { StudioContext } from './context'
import { StudioError } from './errors'
import { ownAsset, queueJob, toEditorJob, type JobRow } from './jobs'
import {
  fitQualityFrom,
  forgeScoreFrom,
  FORGE_RECIPES,
  JUDGE_ACTIONS,
  judgeResultFrom,
  MAX_FIT_SECONDS,
  MAX_FORGED,
  MAX_JUDGED,
  MAX_JUDGED_SECONDS,
  type JudgeAction,
  type JudgeSource,
  type SoundJudgeInput,
  type SoundJudgeResult,
  type SoundMakeInput,
  type SoundMakeResult,
} from './sound-contract'

const BANK_ID = /^[a-z0-9_]+(\/[a-z0-9_.-]+)*$/i
const ASSET_ID = /^[a-f0-9]{64}$/

/** A short text, trimmed, or undefined. Pure. */
const words = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)

/** A list of short texts (at most `count`), or a 400. Pure. */
function wordList(value: unknown, what: string, count: number, max = 200): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > count || value.some((v) => typeof v !== 'string')) throw new StudioError(`${what} is a list of at most ${count} short texts.`)
  const list = (value as string[]).map((v) => v.trim().slice(0, max)).filter(Boolean)
  return list.length ? list : undefined
}

/** A number in a range, or undefined, or a 400. Pure. */
function optional(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new StudioError(`${what} must be a number from ${min} to ${max}.`)
  return n
}

/** A library asset that holds sound and is no longer than `maxSeconds`, or the sentence that refuses it. */
async function soundAsset(ctx: StudioContext, id: unknown, maxSeconds: number): Promise<EditorAsset> {
  if (typeof id !== 'string' || !ASSET_ID.test(id)) throw new StudioError('An asset id is a library asset id (list_studio_assets).')
  const asset = await getAsset(ctx, id)
  if (!asset.hasAudio) throw new StudioError(`${asset.name} has no sound.`)
  if ((asset.durationSeconds ?? 0) > maxSeconds) throw new StudioError(`${asset.name} is longer than ${maxSeconds} seconds.`)
  return asset
}

/** A bank sound id, or a 400. Pure. */
function bankId(value: unknown): string {
  if (typeof value !== 'string' || !BANK_ID.test(value) || value.length > 120) throw new StudioError(`"${String(value).slice(0, 60)}" is not a bank sound id (list_studio_sounds).`)
  return value
}

/** How many sounds each judgement takes, and what it says when given too few or too many. Pure. */
export function checkJudgeCounts(action: JudgeAction, count: number, input: Pick<SoundJudgeInput, 'description' | 'target'>): void {
  const refuse = (sentence: string) => {
    throw new StudioError(sentence)
  }
  if (count > MAX_JUDGED) refuse(`One judgement hears at most ${MAX_JUDGED} sounds.`)
  if ((action === 'describe' || action === 'measure') && count !== 1) refuse(`${action === 'describe' ? 'Describing' : 'Measuring'} hears one sound: give one asset or one bank sound.`)
  if (action === 'realness' && count < 1) refuse('Realness needs at least one sound.')
  if (action === 'compare' && count < 3) refuse('Compare hears one sound against two or more references: give three sounds or more.')
  if (action === 'rank' && count < 2) refuse('Ranking needs two sounds or more.')
  if (action === 'rank' && !input.description && !input.target) refuse('Ranking needs a description or a target sound.')
  if (action === 'find' && !input.description) refuse('Finding needs a description of the sound.')
  if (action === 'find' && count > 1) refuse('Finding looks inside one sound, or (with none) in the bank.')
  if (action === 'ab' && count !== 2 && count < 4) refuse('An A/B hears two sounds (A then B), and any references after them come two or more.')
}

/**
 * POST /sounds/judge {action, assetIds?, sounds?, description?, alts?, targetAssetId? | targetSound?, start?, end?,
 * category?, top?}: earshot's ears on library audio (assetIds) and bank sounds (sounds), as a job.
 */
export async function startJudgeSound(ctx: StudioContext, body: Record<string, unknown>): Promise<{ job: EditorJob }> {
  requireCapability(ctx, 'sound')
  const action = body.action as JudgeAction
  if (!(JUDGE_ACTIONS as readonly unknown[]).includes(action)) throw new StudioError(`action is one of ${JUDGE_ACTIONS.join(', ')}.`)
  const assetIds = body.assetIds ?? body.asset_ids ?? []
  const bankIds = body.sounds ?? []
  if (!Array.isArray(assetIds) || !Array.isArray(bankIds)) throw new StudioError('assetIds and sounds are lists.')
  const input: SoundJudgeInput = { action, sounds: [] }
  const description = words(body.description, 300)
  if (description) input.description = description
  const alts = wordList(body.alts, 'alts', 5)
  if (alts) input.alts = alts
  const targetAsset = body.targetAssetId ?? body.target_asset_id
  const targetSound = body.targetSound ?? body.target_sound
  if (targetAsset !== undefined && targetAsset !== null) input.target = { asset: await soundAsset(ctx, targetAsset, MAX_JUDGED_SECONDS) }
  else if (targetSound !== undefined && targetSound !== null) input.target = { sound: bankId(targetSound) }
  if (input.target && action !== 'rank') throw new StudioError('A target sound is for ranking.')
  checkJudgeCounts(action, assetIds.length + bankIds.length, input)
  const sources: JudgeSource[] = []
  for (const id of assetIds) sources.push({ asset: await soundAsset(ctx, id, MAX_JUDGED_SECONDS) })
  for (const id of bankIds) sources.push({ sound: bankId(id) })
  input.sounds = sources
  const start = optional(body.start, 'start', 0, MAX_JUDGED_SECONDS)
  const end = optional(body.end, 'end', 0.005, MAX_JUDGED_SECONDS)
  if (start !== undefined && end !== undefined && end <= start) throw new StudioError('end comes after start.')
  if (start !== undefined) input.start = start
  if (end !== undefined) input.end = end
  const category = words(body.category, 40)
  if (category && !/^[a-z0-9_]+$/.test(category)) throw new StudioError('category is a bank category (whoosh_fast, pop, impact, …).')
  if (category) input.category = category
  const top = optional(body.top, 'top', 1, 25)
  if (top !== undefined) input.top = Math.round(top)
  return { job: toEditorJob(await queueJob(ctx, 'sound-judge', input)) }
}

/** The kit roles that name a recipe by another word. */
const ROLE_RECIPES: Readonly<Record<string, string>> = {
  hit: 'cuthit', land: 'thump', tick: 'hover', tock: 'knock', ding: 'notify', bell: 'sting', key: 'keypress', snap: 'click',
  text: 'typing', drop: 'subdrop', swell: 'revcymbal', boom: 'impact', chime: 'sting', glock: 'mallet', kalimba: 'pluck',
}

/** The words of a text that carry meaning (three letters or more, no plural s). Pure. */
const meaningful = (text: string): string[] => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((w) => w.replace(/s$/, '')).filter((w) => !['the', 'and', 'with', 'into', 'that', 'for', 'when', 'over', 'short', 'small', 'soft', 'quick', 'sound', 'effect'].includes(w))

/**
 * The forge recipe for a kind (a recipe name, or a kit role such as whoosh.short or hit), else the recipe whose name
 * and target share the most words with the description, else null. Pure.
 */
export function pickRecipe(kind: string | undefined, description: string): string | null {
  if (kind) {
    const k = kind.trim().toLowerCase()
    const family = k.split('.')[0]!
    return [k, family, ROLE_RECIPES[k], ROLE_RECIPES[family]].find((r): r is string => !!r && r in FORGE_RECIPES) ?? null
  }
  const asked = new Set(meaningful(description))
  let best: { recipe: string; score: number } | null = null
  for (const [recipe, target] of Object.entries(FORGE_RECIPES)) {
    const own = new Set([...meaningful(recipe.replace(/_/g, ' ')), ...meaningful(target)])
    const score = [...asked].filter((w) => own.has(w)).length + (asked.has(recipe) ? 2 : 0)
    if (score > 0 && (!best || score > best.score)) best = { recipe, score }
  }
  return best?.recipe ?? null
}

/**
 * POST /sounds/make {description, kind?, count?, alts?} (forge) or {fromAssetId, description?} (fit): a new sound made
 * in code, or a recording turned into code, as a job. The sounds land in the library; nothing is placed.
 */
export async function startMakeSound(ctx: StudioContext, body: Record<string, unknown>): Promise<{ job: EditorJob }> {
  requireCapability(ctx, 'sound')
  const description = words(body.description, 300)
  const from = body.fromAssetId ?? body.from_asset_id
  let input: SoundMakeInput
  if (from !== undefined && from !== null) {
    input = { mode: 'fit', asset: await soundAsset(ctx, from, MAX_FIT_SECONDS), ...(description ? { description } : {}) }
  } else {
    if (!description) throw new StudioError('Describe the sound to make (what it is, not what it is for), or give fromAssetId to turn a recording into code.')
    const kind = words(body.kind, 40)
    const recipe = pickRecipe(kind, description)
    if (!recipe) throw new StudioError(`${kind ? `"${kind}" is not a kind earshot can make` : 'No recipe fits that description'}: name a kind, one of ${Object.keys(FORGE_RECIPES).join(', ')}.`)
    const count = optional(body.count, 'count', 1, MAX_FORGED) ?? 2
    const alts = wordList(body.alts, 'alts', 5)
    input = { mode: 'forge', recipe, description, count: Math.round(count), ...(alts ? { alts } : {}) }
  }
  return { job: toEditorJob(await queueJob(ctx, 'sound-make', input)) }
}

/** A finished `sound-judge` job: its answer checked again and kept as is (compact). */
export async function fileSoundJudge(row: Pick<JobRow, 'input'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as SoundJudgeInput
  const result: SoundJudgeResult = judgeResultFrom(raw, input.action)
  if (!result.summary) throw new StudioError('The judgement came back with nothing heard.')
  return result as unknown as Record<string, unknown>
}

/**
 * A finished `sound-make` job: every made sound checked against what the job stored (named by its bytes, those bytes
 * there) before any is registered, then registered in the library. Answers ids and numbers, never placed.
 */
export async function fileSoundMake(ctx: StudioContext, row: Pick<JobRow, 'input'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as SoundMakeInput
  const out = raw as unknown as SoundMakeResult
  const made = Array.isArray(out.made) ? out.made.slice(0, MAX_FORGED) : []
  if (!made.length) throw new StudioError('No sound came back.')
  const checked: EditorAsset[] = []
  for (const item of made) {
    const asset = EditorAssetSchema.parse(item?.asset)
    if (asset.kind !== 'audio' || !asset.hasAudio) throw new StudioError('A made sound is not an audio file.')
    checked.push(await ownAsset(ctx, asset, 'made sound'))
  }
  const sounds: Record<string, unknown>[] = []
  for (const [i, asset] of checked.entries()) {
    const kept = await registerAsset(ctx, asset)
    const item = made[i]!
    sounds.push({
      assetId: kept.id,
      name: String(item.name || kept.name).slice(0, 200),
      seconds: Math.round((kept.durationSeconds ?? 0) * 1000) / 1000,
      ...(input.mode === 'forge' ? { score: forgeScoreFrom(item.score) } : { quality: fitQualityFrom(item.quality) }),
    })
  }
  return {
    mode: input.mode,
    ...(input.mode === 'forge' ? { recipe: input.recipe, description: input.description } : { fittedFrom: input.asset.id, ...(input.description ? { description: input.description } : {}) }),
    made: sounds,
    summary: String(out.summary ?? '').slice(0, 1500),
  }
}
