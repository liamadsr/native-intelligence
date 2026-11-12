import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { isRefusal, missingRefusal, refusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import { GENERATE_STUDIO_NARRATION, GENERATE_STUDIO_SHOT } from '@/lib/studio/agent/spend-card'
import type { StudioContext } from '@/lib/studio/server/context'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video (list_studio_projects lists them, with their ids)')

/** How long a tool waits on the worker for a narration before answering its job id. */
const NARRATION_WAIT_MS = 90_000

/** The money rules, in every spending tool's description. */
const MONEY_RULES =
  'Money rules: cheap drafts before finals, and never spend from a plan the person has not seen (show them the quote first). A decline is an answer: do not ask again or try another way.'

/**
 * The Studio's paid media (src/lib/studio/server/voiceover.ts, generation.ts, costs.ts): narration in the
 * workspace's voice (ElevenLabs), generated stills and clips for storyboard beats (Higgsfield), and what a video has
 * cost. The provider work runs in the Studio worker, on the provider accounts it holds (its key, its signed-in tool);
 * these tools queue it and read it back, through the same server functions the editor uses, so they are refused
 * where those are: in a workspace the server's STUDIO_PROVIDER_WORKSPACES does not list (capabilities.ts).
 *
 *   get_studio_voice / list_studio_voices / set_studio_voice   the narration voice
 *   quote_studio_narration      characters, and whether this exact narration is cached (free)
 *   generate_studio_narration   spends when not cached: only as the person's approved call
 *   quote_studio_shot           a beat's still or clip price (free)
 *   generate_studio_shot        spends: only as the person's approved call, at a price no higher than its input
 *   get_studio_costs            what a video cost through the Studio
 *
 * Spending is provider spend on the accounts the Studio worker holds (per-workspace provider keys do not exist yet),
 * never Native Intelligence's AI usage: no credits are debited here (no logUsage); the Studio's cost ledger records
 * it. The two spending tools are external-write in the registry, and the outward gate (src/lib/safety/outward-gate.ts,
 * via src/lib/studio/agent/spend-card.ts) holds every call that would spend for the person's card; outside the replay
 * of that card each refuses with APPROVAL_REQUIRED, and on the replay each spends only the request the card pinned
 * (its hash), else CARD_CHANGED. Long work answers a job id for get_studio_job /
 * wait_for_studio_job. Each refuses a workspace guest, and every refusal is `{ success: false, code, error }`.
 */
export function createStudioMediaTools(userId: string, workspaceId?: string, options: { approvedCall?: ApprovedCall } = {}) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>, missing?: Parameters<typeof studioRefusal>[1]): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error, missing)
    }
  }
  const approved = (tool: string) => options.approvedCall?.tool === tool
  /** The request hash the card pinned for this spend, or null (an older card, or one made without it). */
  const pinned = (kind: 'narration' | 'shot') => (options.approvedCall?.studioSpend?.kind === kind ? options.approvedCall.studioSpend.request_hash : null)
  /** The video, or a refusal when it is not here. */
  const video = async (ctx: StudioContext, id: string) => {
    const { getVideoRow } = await import('@/lib/studio/server/videos')
    const row = await getVideoRow(ctx, id)
    return row && !row.archived_at ? row : null
  }
  const server = () => import('@/lib/studio/server/voiceover')
  const shots = () => import('@/lib/studio/server/generation')

  return {
    get_studio_voice: tool({
      description: "The workspace's narration voice (ElevenLabs): its id, name, model and settings, or none chosen yet; and whether narration can be made right now (a Studio worker with an ElevenLabs key is running).",
      inputSchema: z.object({}),
      execute: async () =>
        withStudio(async (ctx) => {
          const { voiceoverInfo } = await server()
          const info = await voiceoverInfo(ctx)
          return {
            success: true,
            voice: info.voice ? { voice_id: info.voice.voiceId, name: info.voice.name, model_id: info.voice.modelId, ...(info.voice.settings ? { settings: info.voice.settings } : {}), ...(info.voice.substitutions ? { substitutions: info.voice.substitutions } : {}) } : null,
            narration_available: info.available,
            ...(info.voice ? {} : { note: 'No voice yet: list_studio_voices, then set_studio_voice with the one the person picks.' }),
          }
        }),
    }),

    list_studio_voices: tool({
      description: "The voices of the workspace's ElevenLabs account, to choose a narration voice from (kept an hour; refresh: true reads them again). Needs the Studio worker with an ElevenLabs key.",
      inputSchema: z.object({ refresh: z.boolean().optional().describe('Read the list again now') }),
      execute: async ({ refresh }) =>
        withStudio(async (ctx) => {
          const { listVoices } = await server()
          const { voices, at } = await listVoices(ctx, { refresh: refresh === true })
          return { success: true, voices: voices.slice(0, 100).map((v) => ({ voice_id: v.voiceId, name: v.name, ...(v.category ? { category: v.category } : {}) })), listed_at: at, ...(voices.length > 100 ? { more: voices.length - 100 } : {}) }
        }),
    }),

    set_studio_voice: tool({
      description:
        "Choose the workspace's narration voice (a voice_id from list_studio_voices), with an optional model and settings (stability, similarityBoost, style 0–1; speed 0.7–1.2; useSpeakerBoost) and substitutions (how words are read: {\"Acme\": \"Ack me\"}). Changing it changes every later narration's price and sound.",
      inputSchema: z.object({
        voice_id: z.string().describe('From list_studio_voices'),
        model_id: z.string().optional().describe('An ElevenLabs model id; the default when left out'),
        settings: z.record(z.string(), z.unknown()).optional(),
        substitutions: z.record(z.string(), z.string()).optional(),
      }),
      execute: async ({ voice_id, model_id, settings, substitutions }) =>
        withStudio(async (ctx) => {
          const { saveVoice } = await server()
          const voice = await saveVoice(ctx, { voiceId: voice_id, ...(model_id ? { modelId: model_id } : {}), ...(settings ? { settings } : {}), ...(substitutions ? { substitutions } : {}) })
          return { success: true, voice: { voice_id: voice.voiceId, name: voice.name, model_id: voice.modelId } }
        }),
    }),

    quote_studio_narration: tool({
      description: "What narration of a text in the workspace's voice would cost: its characters (ElevenLabs credits) and whether this exact narration is already cached (then it is free). Spends nothing. Show the person before generate_studio_narration.",
      inputSchema: z.object({ video_id: videoId, text: z.string().describe('The narration, as it should be spoken') }),
      execute: async ({ video_id, text }) =>
        withStudio(async (ctx) => {
          if (!(await video(ctx, video_id))) return missingRefusal('video')
          const { previewNarration } = await server()
          const p = await previewNarration(ctx, text)
          return { success: true, characters: p.characters, cached: p.cached, voice: p.voiceName, model_id: p.modelId, ...(p.cached ? { note: 'Cached: generating it costs nothing.' } : { note: `Uses about ${p.characters} ElevenLabs credits.` }) }
        }),
    }),

    generate_studio_narration: tool({
      description:
        "Make narration of a text in the workspace's voice (ElevenLabs, with word timings): a library audio asset with its transcript. A cached narration runs at once and costs nothing. One that isn't cached uses the person's ElevenLabs credits, so it is held for their yes on an approval card and runs only when they accept. " +
        "place puts it over the whole video's footage (keep-footage refuses one longer than the footage; hold-last-frame holds the last frame); left out, it is only made. " +
        MONEY_RULES,
      inputSchema: z.object({
        video_id: videoId,
        text: z.string().describe('The narration, as it should be spoken (quote_studio_narration first)'),
        place: z.enum(['keep-footage', 'hold-last-frame']).optional().describe('Put it over the whole video'),
      }),
      execute: async ({ video_id, text, place }) =>
        withStudio(async (ctx) => {
          if (!(await video(ctx, video_id))) return missingRefusal('video')
          const { NARRATION_CHANGED, narrationAnswer, placeNarration, previewNarration, startNarration } = await server()
          const preview = await previewNarration(ctx, text)
          if (!preview.cached && !approved(GENERATE_STUDIO_NARRATION)) {
            return refusal('APPROVAL_REQUIRED', `Nothing was spent. This narration isn't cached, so it uses about ${preview.characters} ElevenLabs credits and runs only from the person's own approval card.`)
          }
          // The card pinned the exact request (voice, model, substitutions, text): anything else spends nothing.
          const expectHash = preview.cached ? undefined : pinned('narration')
          if (!preview.cached && expectHash !== preview.requestHash) return refusal('CARD_CHANGED', NARRATION_CHANGED)
          const started = await startNarration(ctx, text, { allowPaid: !preview.cached, videoId: video_id, ...(expectHash ? { expectHash } : {}) })
          let result = 'result' in started ? started.result : null
          let cancelled = false
          if (!result && 'job' in started) {
            const { waitForJob } = await import('@/lib/studio/server/jobs')
            const row = await waitForJob(ctx, started.job.id, { timeoutMs: NARRATION_WAIT_MS, everyMs: 1500 })
            // Paid for and not delivered: a refusal (UNDELIVERED) with the worker's sentence, the charge in the costs.
            result = await narrationAnswer(ctx, row)
            if (!result)
              return {
                success: true, status: 'running', job_id: started.job.id,
                note: 'Still being made: wait_for_studio_job, then call this again with the same text (once made it is cached and costs nothing more). If it ends not delivered, it may have been charged: tell the person to check the costs and the ElevenLabs history before generating it again.',
              }
            cancelled = row.cancel_requested
          }
          const answer = { success: true, asset_id: result!.asset.id, transcript_id: result!.transcript.id, seconds: Math.round((result!.asset.durationSeconds ?? 0) * 100) / 100, cached: result!.cached }
          // Made after the person asked to stop: kept in the library (and cached), not put on the video.
          if (cancelled) return { ...answer, placed: false, note: 'This narration was cancelled while it was made: it is in the library (cached, so using it costs nothing more) and was not put on the video.' }
          if (!place) return { ...answer, placed: false }
          const { projectDigest } = await placeNarration(ctx, video_id, result!, place)
          return { ...answer, placed: true, digest: projectDigest }
        }),
    }),

    quote_studio_shot: tool({
      description:
        "The price of a storyboard beat's generated still or clip, as it would run (Higgsfield credits, the account's balance and plan, the quality pinned and why). A draft is the cheapest model that can take the beat's inputs, at its lowest quality (the others tried are listed); final: true quotes the beat's good model at full quality. " +
        "A clip needs an approved still (the person approves a beat's still in the Studio's storyboard); a final clip needs a draft clip first; a person in the cast needs their consent. Spends nothing.",
      inputSchema: z.object({ video_id: videoId, beat_id: z.string(), what: z.enum(['still', 'clip']), final: z.boolean().optional() }),
      execute: async ({ video_id, beat_id, what, final }) =>
        withStudio(async (ctx) => {
          const { quoteBeat } = await shots()
          const { quote, tried } = await quoteBeat(ctx, video_id, beat_id, { what, final: final === true })
          return {
            success: true,
            model: quote.model,
            credits: quote.credits,
            tier: quote.tier,
            ...(typeof quote.balance === 'number' ? { balance: quote.balance } : {}),
            ...(quote.plan ? { plan: quote.plan } : {}),
            ...(quote.changes.length ? { quality_pinned: quote.changes.map((c) => `${c.name}: ${String(c.from)} → ${c.to}`) } : {}),
            ...(tried?.length ? { tried: tried.map((t) => (t.credits !== undefined ? `${t.model} ${t.credits}` : `${t.model} (${t.skipped})`)) } : {}),
          }
        }),
    }),

    generate_studio_shot: tool({
      description:
        "Generate a storyboard beat's still or clip on the person's Higgsfield account and place it on the beat (a clip is graded toward the camera footage). It spends their credits, so it is held for their yes on an approval card and runs only when they accept. " +
        'model and credits must be a fresh quote_studio_shot answer: it spends only when the price is that model at no more credits, else nothing. Answers the job: wait_for_studio_job. ' +
        MONEY_RULES,
      inputSchema: z.object({
        video_id: videoId,
        beat_id: z.string(),
        what: z.enum(['still', 'clip']),
        final: z.boolean().optional(),
        model: z.string().describe('The model quote_studio_shot answered'),
        credits: z.number().describe('The credits quote_studio_shot answered'),
      }),
      execute: async ({ video_id, beat_id, what, final, model, credits }) =>
        withStudio(async (ctx) => {
          if (!approved(GENERATE_STUDIO_SHOT)) return refusal('APPROVAL_REQUIRED', "Nothing was spent. generate_studio_shot spends the person's Higgsfield credits and runs only from their own approval card.")
          const { SHOT_CHANGED, startShot } = await shots()
          // The card pinned what the beat asks of the provider: anything else (or a card without it) spends nothing.
          const expectHash = pinned('shot')
          if (!expectHash) return refusal('CARD_CHANGED', SHOT_CHANGED)
          const job = await startShot(ctx, video_id, beat_id, { what, final: final === true, confirm: { model, credits } }, { expectHash })
          return { success: true, job_id: job.id, status: job.status === 'queued' ? 'queued' : 'running', note: 'wait_for_studio_job until it is done; the shot is placed on the beat when it is made.' }
        }),
    }),

    get_studio_costs: tool({
      description: 'What a video has cost through the Studio: dollars and credits by provider and by model, its latest charges, and how many charges no video owns. Only what was spent through the Studio is counted.',
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          if (!(await video(ctx, video_id))) return missingRefusal('video')
          const { videoCosts } = await import('@/lib/studio/server/costs')
          const s = await videoCosts(ctx, video_id)
          const usd = (v: number) => Math.round(v * 100) / 100
          return {
            success: true,
            usd: usd(s.usd),
            providers: s.providers.map((p) => ({ provider: p.provider, credits: p.credits, usd: usd(p.usd), count: p.count })),
            models: s.models.slice(0, 8).map((m) => ({ model: m.model, kind: m.kind, count: m.count, credits: m.credits, usd: usd(m.usd) })),
            charges: s.entries.slice(0, 20).map((e) => ({ at: e.at, provider: e.provider, model: e.model, kind: e.kind, credits: e.credits, usd: usd(e.usd) })),
            unassigned: s.unassigned.length,
            note: s.warnings[0],
          }
        }),
    }),
  }
}
