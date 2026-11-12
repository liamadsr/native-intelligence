/**
 * Higgsfield through its command-line tool, signed in to the person's account
 * where this worker runs (STUDIO_HIGGSFIELD_BIN, else `higgsfield` on PATH).
 * Every call is `--json`. Quotes are free; `generate create` spends.
 *
 *   account status            balance and plan
 *   model get <model>         a model's parameters
 *   generate cost <model> …   the price of a generation as it would run
 *   generate create <model> … the spend: answers the provider's job
 *   generate wait <job>       until it is done: answers its result links
 *
 * Drafts run at each model's lowest quality (the engine's
 * generation-quality.ts). A model the person's plan can't run is learned the
 * first time Higgsfield says so ("Pro" or "Ultimate" plan required); the app
 * keeps those refusals and hands them back with every job, and a refused
 * model is not quoted again on the same plan (an upgrade clears it: the plan
 * name differs).
 *
 * The tool is somebody else's program handed the person's words: it runs in
 * the job's scratch folder (so a relative name can only mean a file the job
 * put there) with a minimal environment (its own sign-in settings, no worker
 * secret, no other provider's key), in a process group of its own; a model name
 * is checked before any call names it; every parameter goes as one
 * `--name=value` word (a prompt that starts with `-` is never read as an
 * option); a media parameter must be a file the job staged in scratch; and a
 * price that is not a number above zero is no price.
 */
import type { ModelParamInfo, PlanBlock, QuoteTried, ShotQuote } from '../../../web/src/lib/studio/server/provider-contract.ts'
import { applyQualityTier } from '../engine.ts'
import { JobError, SpendUnknown } from '../jobs/context.ts'
import { minimalEnv, pick, runTool } from '../child.ts'
import { findBinary } from '../media.ts'

/** Runs the tool with these arguments and answers its standard output (a test passes a fake). */
export type HfRunner = (args: string[], opts: { timeout: number; signal?: AbortSignal }) => Promise<string>

/** The tool's path: the setting, else wherever it is installed, else its bare name (it fails as "not installed"). */
export function higgsfieldPath(setting: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return setting ?? findBinary('higgsfield', [], env) ?? 'higgsfield'
}

/** The last two lines the tool wrote, without "Error:", as one sentence's worth. Pure. */
export function toolMessage(stderr: string, fallback: string): string {
  const lines = String(stderr || fallback).split('\n').map((l) => l.replace(/^Error:\s*/, '').trim()).filter(Boolean)
  return lines.slice(-2).join(' ') || 'The higgsfield tool failed without a message.'
}

/** The tool's environment: the minimal one, plus its own settings (HIGGSFIELD_*) and where its sign-in lives. Pure over `env`. */
export function toolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalEnv(pick(env, ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'NODE_EXTRA_CA_CERTS'], ['HIGGSFIELD_']), env)
}

/** The real tool, as a runner, in `cwd` (the job's scratch folder; the worker's own folder is never it). */
export function toolRunner(bin: string, cwd?: string): HfRunner {
  return async (args, opts) => {
    let r
    try {
      r = await runTool(bin, args, { env: toolEnv(), cwd: cwd ?? (process.env.TMPDIR || '/tmp'), timeout: opts.timeout, signal: opts.signal, maxBuffer: 32 * 1024 * 1024 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new JobError('The higgsfield tool is not installed where the Studio worker runs.')
      throw err
    }
    if (r.stopped === 'signal' || opts.signal?.aborted) throw new JobError('The higgsfield tool stopped: the job was cancelled.')
    if (r.stopped === 'timeout') throw new Error(`The higgsfield tool timed out. ${toolMessage(r.stderr, '')}`.trim())
    if (r.code !== 0) throw new Error(toolMessage(r.stderr, `exit ${r.code}`))
    return r.stdout
  }
}

/** One call, `--json`, parsed. */
export async function hf<T = unknown>(run: HfRunner, args: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<T> {
  const out = await run([...args, '--json'], { timeout: opts.timeout ?? 120_000, signal: opts.signal })
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`The higgsfield tool answered something that is not JSON: ${out.slice(0, 160)}`)
  }
}

// ---- pure ---------------------------------------------------------------------------------------------------------

/** A parameter's name as the tool takes it. */
const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Every parameter as one `--name=value` word (lists repeat it), so no value is ever read as an option of its own;
 * local image paths are uploaded by the tool. Throws for a name that is not a plain parameter name. Pure.
 */
export const toFlags = (params: Record<string, unknown>) =>
  Object.entries(params).flatMap(([k, v]) => {
    if (!PARAM_NAME.test(k)) throw new JobError(`"${k.slice(0, 40)}" is not a parameter the generation tool takes`)
    return (Array.isArray(v) ? v : [v]).map((x) => `--${k.replace(/_/g, '-')}=${typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)}`)
  })

/** The parameters the tool reads as media (a local path it uploads, or an upload's or a job's id). */
export const MEDIA_PARAMS = new Set(['image_references', 'video_references', 'audio_references', 'start_image', 'end_image', 'image', 'video', 'audio', 'reference_images', 'input_images', 'images', 'mask'])
const looksLikeMedia = (name: string) => MEDIA_PARAMS.has(name) || /(image|video|audio|reference|frame|mask|file)/.test(name)
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Throws unless every media parameter's value is a file the job staged (one of `staged`, absolute paths in its
 * scratch folder) or an upload's id: a person's words can never make the tool upload another file. Pure.
 */
export function checkMedia(params: Record<string, unknown>, staged: ReadonlySet<string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!looksLikeMedia(name)) continue
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === null || v === undefined || v === false) continue
      if (typeof v === 'string' && (staged.has(v) || UPLOAD_ID.test(v))) continue
      throw new JobError(`The generation's ${name} must be media from the library (the job's own files); "${String(typeof v === 'string' ? v : typeof v).slice(0, 60)}" is not one.`)
    }
  }
}

/** Every https result link in a finished job (or a list of them), once each. Pure. */
export function resultUrls(job: unknown): string[] {
  const one = (j: unknown): unknown[] => {
    const o = (j ?? {}) as { result_url?: unknown; result_urls?: unknown; results?: unknown }
    return [
      o.result_url,
      ...(Array.isArray(o.result_urls) ? o.result_urls : []),
      ...(Array.isArray(o.results) ? o.results.map((r) => (typeof r === 'string' ? r : (r as { url?: unknown; result_url?: unknown })?.url ?? (r as { result_url?: unknown })?.result_url)) : []),
    ]
  }
  const all = (Array.isArray(job) ? job.flatMap(one) : one(job)).filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
  return [...new Set(all)]
}

/** The provider's job id in what `generate create` answered. Pure. */
export function jobIdOf(job: unknown): string | undefined {
  const first = Array.isArray(job) ? job[0] : job
  if (typeof first === 'string') return first
  const o = (first ?? {}) as { id?: unknown; job_id?: unknown; jobs?: { id?: unknown }[] }
  const id = o.id ?? o.job_id ?? o.jobs?.[0]?.id
  return typeof id === 'string' && id ? id : undefined
}

/** The plans a refusal names ("Pro" or "Ultimate" plan required), lower-cased, or null when it is no plan refusal. Pure. */
export function planRefusal(message: string): string[] | null {
  const m = /"?([A-Za-z]+)"?\s+or\s+"?([A-Za-z]+)"?\s+plan required/i.exec(message) ?? /"?([A-Za-z]+)"?\s+plan required/i.exec(message)
  return m ? m.slice(1).filter(Boolean).map((p) => p.toLowerCase()) : null
}

/** A model name the tool takes: never one that could read as an option. Pure. */
export const isModelName = (model: unknown): model is string => typeof model === 'string' && /^[a-z0-9][a-z0-9_.-]{1,79}$/.test(model)

/** A price the tool answered: a finite number of credits above zero, else null (no price is never a price of 0). Pure. */
export function priceOf(cost: unknown): number | null {
  const credits = (cost as { credits?: unknown } | null)?.credits
  const n = typeof credits === 'number' ? credits : typeof credits === 'string' && credits.trim() ? Number(credits) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

// Model policy: drafts use the cheapest model that can do the job, at its lowest quality; only a beat whose prompt is
// final is generated with the good model, at full quality. These lists are data and they go stale: the provider adds
// and retires models. A model that is gone is skipped ("not available") when a draft is quoted.
export const draftCandidates = {
  video: ['kling3_0_turbo', 'seedance_2_0_mini', 'veo3_1_lite', 'wan3_0', 'minimax_hailuo', 'grok_video_v15_lite', 'kling3_0'],
  image: ['nano_banana_flash', 'nano_banana_2_lite', 'seedream_5_0_flash', 'nano_banana_pro'],
} as const
export const finalDefaults = { video: 'seedance_2_5', image: 'nano_banana_pro' } as const

const refKeys = ['image_references', 'reference_images', 'input_images', 'images', 'image']

/**
 * Only the parameters a model accepts; reference images moved to whatever the
 * model calls them; the duration rounded up to one it makes. Null when it can't
 * take these inputs. Pure.
 */
export function fitParams(params: Record<string, unknown>, schema: ModelParamInfo[]): Record<string, unknown> | null {
  const names = new Set(schema.map((p) => p.name))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) if (k !== 'references' && names.has(k)) out[k] = v
  if (params.start_image && !names.has('start_image')) return null
  // Some models take a start image only in a reference mode (Seedance: mode omni_reference).
  const mode = schema.find((p) => p.name === 'mode')
  if (params.start_image && mode?.enum?.includes('omni_reference') && out.mode === undefined) out.mode = 'omni_reference'
  const refs = params.references as string[] | undefined
  if (refs?.length) {
    const key = refKeys.find((k) => names.has(k))
    if (!key) return null
    out[key] = key === 'image' ? refs[0] : refs
  }
  if (!names.has('prompt')) return null
  const aspect = schema.find((p) => p.name === 'aspect_ratio')
  if (out.aspect_ratio && aspect?.enum && !aspect.enum.includes(String(out.aspect_ratio))) delete out.aspect_ratio
  const duration = schema.find((p) => p.name === 'duration')
  // The shortest length that covers the beat (handles to trim), else the longest the model makes.
  if (out.duration !== undefined && duration?.enum?.length) {
    const want = Number(out.duration)
    const options = duration.enum.map(Number).sort((a, b) => a - b)
    out.duration = options.find((o) => o >= want) ?? options.at(-1)!
  }
  return out
}

/** The best quality short of 4k for a final (1080p, pro), in the model's own options. Pure. */
export function finalQuality(schema: ModelParamInfo[], params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params }
  const rank = (v: string) => ({ '480p': 1, '540p': 2, '720p': 3, std: 3, standard: 3, '1k': 3, '1080p': 5, pro: 5, high: 5, '2k': 5 } as Record<string, number>)[v.toLowerCase()] ?? 0
  for (const p of schema) {
    if (['resolution', 'mode', 'quality', 'bitrate_mode'].includes(p.name) && p.enum?.some((v) => rank(v) > 0) && out[p.name] === undefined) {
      out[p.name] = [...p.enum].filter((v) => rank(v) > 0).sort((a, b) => rank(b) - rank(a))[0]
    }
  }
  return out
}

/** Whether a spend matches what the person confirmed: the same model, and no more credits than they saw. Pure. */
export const matchesConfirm = (quote: Pick<ShotQuote, 'model' | 'credits'>, confirm: { model: string; credits: number }) =>
  !!confirm && quote.model === confirm.model && Number.isFinite(quote.credits) && quote.credits > 0 && Number.isFinite(confirm.credits) && confirm.credits > 0 && quote.credits <= confirm.credits + 0.001

/** A spend that may have been charged though no job id came back (jobs/context.ts). */
export { SpendUnknown }

// ---- the account ---------------------------------------------------------------------------------------------------

export type Account = { credits?: number; subscription_plan_type?: string }

/** Quoting and spending with the tool, for one job. */
export class Higgsfield {
  private account: Promise<Account> | null = null
  private readonly schemas = new Map<string, Promise<ModelParamInfo[]>>()
  constructor(
    private readonly run: HfRunner,
    private readonly blocks: Record<string, PlanBlock> = {},
    private readonly signal?: AbortSignal,
    /** The media files the job staged (absolute paths in its scratch folder): the only files a parameter may name. Null: no check (quotes in tests). */
    private readonly staged: ReadonlySet<string> | null = null,
  ) {}

  /** The parameters as flags, every media parameter checked against what the job staged. */
  private flags(params: Record<string, unknown>): string[] {
    if (this.staged) checkMedia(params, this.staged)
    return toFlags(params)
  }

  /** The balance and the plan (read once per job; nothing when the tool can't say). */
  status(): Promise<Account> {
    this.account ??= hf<Account>(this.run, ['account', 'status'], { timeout: 30_000, signal: this.signal }).catch(() => ({}))
    return this.account
  }

  /** A model's parameters (none: it is not available). */
  modelParams(model: string): Promise<ModelParamInfo[]> {
    if (!isModelName(model)) return Promise.reject(new JobError('Unknown model'))
    if (!this.schemas.has(model)) {
      this.schemas.set(model, hf<{ params?: ModelParamInfo[] }>(this.run, ['model', 'get', model], { timeout: 60_000, signal: this.signal }).then((m) => (Array.isArray(m.params) ? m.params : []), () => []))
    }
    return this.schemas.get(model)!
  }

  /** The price of a generation as it will run (draft tier applied), refused early when the plan already failed for the model. */
  async quote(model: string, asked: Record<string, unknown>): Promise<ShotQuote> {
    if (!isModelName(model)) throw new JobError('Unknown model')
    const who = await this.status()
    const plan = who.subscription_plan_type ?? 'unknown'
    const blocked = this.blocks[model]
    if (blocked && blocked.seenOn === plan) throw new JobError(`${model} needs the ${blocked.plans.join(' or ')} plan; your account is on ${plan}. Pick another model.`)
    const { params, tier, changes } = applyQualityTier(asked, await this.modelParams(model))
    const cost = await hf<{ credits?: unknown }>(this.run, ['generate', 'cost', model, ...this.flags(params)], { timeout: 120_000, signal: this.signal })
    const credits = priceOf(cost)
    if (credits === null) throw new JobError(`Higgsfield gave no price for ${model} (it answered ${JSON.stringify(cost).slice(0, 80)}), so nothing is spent on it.`)
    return { model, params, tier, changes, credits, ...(typeof who.credits === 'number' ? { balance: who.credits } : {}), plan }
  }

  /** Every draft candidate that can take these inputs, quoted; the cheapest wins (the others are kept for the record). */
  async cheapestDraft(kind: 'video' | 'image', params: Record<string, unknown>): Promise<{ quote: ShotQuote; tried: QuoteTried[] }> {
    const tried: QuoteTried[] = []
    let best: ShotQuote | null = null
    for (const model of draftCandidates[kind]) {
      try {
        const schema = await this.modelParams(model)
        if (!schema.length) {
          tried.push({ model, skipped: 'not available' })
          continue
        }
        const fitted = fitParams(params, schema)
        if (!fitted) {
          tried.push({ model, skipped: 'cannot take these inputs' })
          continue
        }
        const q = await this.quote(model, fitted)
        tried.push({ model, credits: q.credits })
        if (q.credits > 0 && (!best || q.credits < best.credits)) best = q
      } catch (error) {
        if (this.signal?.aborted) throw error
        tried.push({ model, skipped: (error as Error).message.slice(0, 120) })
      }
    }
    if (!best) throw new JobError(`No draft model could take this: ${tried.map((t) => `${t.model} (${t.skipped ?? t.credits})`).join(', ')}`)
    return { quote: best, tried }
  }

  /** A final: the chosen (or default) good model at full quality. */
  async finalQuote(kind: 'video' | 'image', model: string | undefined, params: Record<string, unknown>): Promise<ShotQuote> {
    const name = model ?? finalDefaults[kind]
    if (!isModelName(name)) throw new JobError('Unknown model')
    const schema = await this.modelParams(name)
    const fitted = fitParams(params, schema)
    if (!fitted) throw new JobError(`${name} can't take these inputs`)
    return this.quote(name, { ...finalQuality(schema, fitted), final: true })
  }

  /**
   * The spend. Answers the provider's job id; a plan refusal comes back as such (nothing was spent). It is never
   * interrupted by the job's signal once it has started (a call cut half way could charge without saying so): it
   * runs to its own answer or its time limit. Anything else that goes wrong may have been charged: SpendUnknown.
   */
  async create(quote: ShotQuote): Promise<{ jobId: string } | { refused: string; plans: string[] }> {
    if (!isModelName(quote.model)) throw new JobError('Unknown model')
    const flags = this.flags(quote.params)
    let job: unknown
    try {
      job = await hf(this.run, ['generate', 'create', quote.model, ...flags], { timeout: 300_000 })
    } catch (error) {
      const message = (error as Error).message
      const plans = planRefusal(message)
      if (plans) return { refused: message, plans }
      throw new SpendUnknown(`Higgsfield did not confirm the generation (${message.slice(0, 300)}). It may have started and been charged: look for it in your Higgsfield account before generating this shot again.`)
    }
    const jobId = jobIdOf(job)
    if (!jobId) throw new SpendUnknown(`No job id in Higgsfield's answer: ${JSON.stringify(job).slice(0, 200)}. It may have started and been charged: look for it in your Higgsfield account before generating this shot again.`)
    return { jobId }
  }

  /** Until the provider's job is done (up to half an hour): its result links. */
  async wait(jobId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(jobId)) throw new Error(`Higgsfield answered a job id the worker can't ask about (${jobId.slice(0, 40)})`)
    const done = await hf(this.run, ['generate', 'wait', jobId, '--timeout=30m'], { timeout: 31 * 60_000, signal: this.signal })
    return resultUrls(done)
  }
}
