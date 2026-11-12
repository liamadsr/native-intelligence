import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { wrapUntrusted } from '@/lib/email/untrusted'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { isRefusal, missingRefusal, refusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import { GENERATE_STUDIO_MUSIC, GENERATE_STUDIO_REVOICE, GENERATE_STUDIO_SOUND_EFFECT, paidAudioBody } from '@/lib/studio/agent/spend-card'
import type { StudioContext } from '@/lib/studio/server/context'
import type { PaidAudioAnswer, PaidAudioKind } from '@/lib/studio/server/voice-media'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video it is for, so its cost lands on that video (list_studio_projects lists them)')

/** How long a spending tool waits on the worker before answering its job id. */
const WAIT_MS = 90_000

/** The money rules, in every spending tool's description. */
const MONEY_RULES =
  'Money rules: quote first and show the person, one card per spend, never retry a spend (a decline is an answer: do not ask again or try another way; one that ends not delivered may have been charged: tell the person to check the costs).'

/** The consent rule, in every re-voice tool's description. */
const CONSENT =
  "A real person's voice only with their say-so: re-voice a real person's recording, or speak in a voice cloned from a real person, only when that person agreed; speaker says which it is. "

/** Where what these make goes: nowhere, until it is placed. */
const PLACED_NOWHERE =
  'It is a library audio asset placed nowhere: import_studio_sound puts a sound effect on the Sound effects track (onset or peak on `at`) or a bed on the music track; the person places a re-voiced line in the editor (and mutes the clip’s own sound under it).'

/** What each spend is called in sentences. */
const WHAT: Record<PaidAudioKind, string> = { revoice: 're-voice', 'sound-effect': 'sound effect', music: 'music bed' }

/** The re-voice inputs, as both its quote and its spend take them. */
const revoiceInput = z.object({
  video_id: videoId,
  asset_id: z.string().describe('The library audio or video whose speech is re-voiced (list_studio_assets)'),
  from: z.number().min(0).optional().describe('Seconds into that file where the stretch starts (default 0)'),
  to: z.number().min(0).optional().describe('Seconds into that file where it ends (default the end, at most 300 s after from)'),
  voice_id: z.string().optional().describe("The voice to re-speak it in (list_studio_voices or search_studio_voices); the workspace's narration voice when left out"),
  speaker: z.enum(['generated', 'person-who-agreed']).describe('Whose speech this is: a generated voice (a generated talking shot), or a real person who agreed to be re-voiced'),
  remove_background_noise: z.boolean().optional().describe('Clean the input first (default true)'),
})

/** The sound effect inputs. */
const soundEffectInput = z.object({
  video_id: videoId,
  description: z.string().describe('What it sounds like: "soft glassy chime", "paper whoosh left to right"'),
  seconds: z.number().min(0.5).max(30).describe('How long, 0.5 to 30 seconds'),
  influence: z.number().min(0).max(1).optional().describe('How literally it follows the description, 0 to 1 (default 0.4)'),
  loop: z.boolean().optional().describe('Made to loop seamlessly (a room tone, a hum)'),
  variants: z.number().int().min(1).max(3).optional().describe('Candidates to make, 1 to 3 (default 1); each is billed'),
  take: z.number().int().min(1).max(50).optional().describe('A new take of the same description (the same take again is cached and free)'),
})

/** The music bed inputs. */
const musicInput = z.object({
  video_id: videoId,
  description: z.string().describe('The bed: mood, tempo, instruments ("bright, steady, major, light percussion, no ending")'),
  seconds: z.number().min(3).max(300).describe('How long, 3 to 300 seconds'),
  instrumental: z.boolean().optional().describe('No vocals (default true)'),
  variants: z.number().int().min(1).max(2).optional().describe('Candidates to make, 1 or 2 (default 1); each is billed'),
  take: z.number().int().min(1).max(50).optional().describe('A new take of the same description (the same take again is cached and free)'),
})

/** A spend's answer as the agent reads it. Pure. */
function made(kind: PaidAudioKind, r: PaidAudioAnswer) {
  return {
    success: true,
    asset_ids: r.assets.map((a) => a.id),
    assets: r.assets.map((a) => ({ asset_id: a.id, name: a.name, seconds: Math.round((a.durationSeconds ?? 0) * 100) / 100 })),
    cached: r.cached,
    placed: false,
    ...(r.transcript ? { transcript_id: r.transcript.id } : {}),
    ...(kind === 'revoice' ? { timing_kept: r.timingKept === true } : {}),
    terms: r.terms,
    note: `${r.note ? `${r.note} ` : ''}${PLACED_NOWHERE}`,
  }
}

/**
 * More of the voice provider than narration (src/lib/studio/server/voice-media.ts), on the provider account the Studio
 * worker holds, refused (NOT_SET_UP) in a workspace the server's STUDIO_PROVIDER_WORKSPACES does not list, on every
 * path, searches and quotes included:
 *
 *   search_studio_voices                                    the account's voices and the shared voice library (free)
 *   quote_studio_revoice / generate_studio_revoice          a recorded or generated line re-spoken in another voice
 *   quote_studio_sound_effect / generate_studio_sound_effect   designed sound effects from a description
 *   quote_studio_music / generate_studio_music              music beds from a description
 *
 * Each generate_ spends the person's own provider credits: external-write in the registry, held by the outward gate
 * for the person's card (src/lib/studio/agent/spend-card.ts paidAudioCard) unless this exact request is cached (then
 * it is free and runs). Outside the replay of that card each refuses with APPROVAL_REQUIRED and spends nothing; on the
 * replay it spends only the request the card pinned (its hash), else CARD_CHANGED. What it makes is a library asset
 * placed nowhere. A workspace guest is refused; every refusal is `{ success: false, code, error }`.
 */
export function createStudioAudioTools(userId: string, workspaceId?: string, options: { approvedCall?: ApprovedCall } = {}) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error)
    }
  }
  const server = () => import('@/lib/studio/server/voice-media')
  /** The video, when it is here and not archived. */
  const video = async (ctx: StudioContext, id: string) => {
    const { getVideoRow } = await import('@/lib/studio/server/videos')
    const row = await getVideoRow(ctx, id)
    return row && !row.archived_at ? row : null
  }
  /** The request hash the card pinned for this kind of spend, or null. */
  const pinned = (kind: PaidAudioKind) => (options.approvedCall?.studioSpend?.kind === kind ? options.approvedCall.studioSpend.request_hash : null)

  /** A quote: what it bills by and whether it is cached. Spends nothing. */
  const quote = (kind: PaidAudioKind) => async (input: { video_id: string } & Record<string, unknown>) =>
    withStudio(async (ctx) => {
      if (!(await video(ctx, input.video_id))) return missingRefusal('video')
      const q = await (await server()).previewPaid(ctx, kind, paidAudioBody(kind, input))
      return {
        success: true,
        cached: q.cached,
        seconds: q.seconds,
        estimated_credits: q.estimatedCredits,
        model_id: q.modelId,
        ...(q.variants ? { variants: q.variants } : {}),
        ...(q.voiceName ? { voice: q.voiceName, from: q.from, to: q.to, source: q.sourceName } : {}),
        terms: q.terms,
        note: q.cached ? 'Cached: making it again costs nothing.' : `The voice provider bills this by the length of the audio: ${q.seconds} seconds, about ${q.estimatedCredits} ElevenLabs credits (an estimate). Show the person before the generate call.`,
      }
    })

  /** A spend: cached and free, or only as the person's approved card, then waited on. */
  const generate = (kind: PaidAudioKind, toolName: string) => async (input: { video_id: string } & Record<string, unknown>) =>
    withStudio(async (ctx) => {
      if (!(await video(ctx, input.video_id))) return missingRefusal('video')
      const { PAID_CHANGED, paidAnswer, previewPaid, startPaid } = await server()
      const body = paidAudioBody(kind, input)
      const preview = await previewPaid(ctx, kind, body)
      if (!preview.cached && options.approvedCall?.tool !== toolName) {
        return refusal('APPROVAL_REQUIRED', `Nothing was spent. This ${WHAT[kind]} isn't cached, so it uses about ${preview.estimatedCredits} ElevenLabs credits (${preview.seconds} seconds of audio) and runs only from the person's own approval card.`)
      }
      // The card pinned the exact request: anything else spends nothing.
      const expectHash = preview.cached ? undefined : pinned(kind)
      if (!preview.cached && expectHash !== preview.requestHash) return refusal('CARD_CHANGED', PAID_CHANGED)
      const started = await startPaid(ctx, kind, body, { allowPaid: !preview.cached, videoId: input.video_id, ...(expectHash ? { expectHash } : {}) })
      if ('result' in started) return made(kind, started.result)
      const { waitForJob } = await import('@/lib/studio/server/jobs')
      // Paid for and not delivered: a refusal (UNDELIVERED) with the worker's sentence, the charge in the costs.
      const result = await paidAnswer(ctx, await waitForJob(ctx, started.job.id, { timeoutMs: WAIT_MS, everyMs: 1500 }))
      if (result) return made(kind, result)
      return {
        success: true, status: 'running', job_id: started.job.id,
        note: `Still being made: wait_for_studio_job, then call this again with the same input (once made it is cached and costs nothing more). If it ends not delivered, it may have been charged: tell the person to check the costs before asking again.`,
      }
    })

  return {
    search_studio_voices: tool({
      description:
        "Search the voice provider's shared voice library, and the account's own voices, for a narrator or a cast member's voice: words (\"warm calm narrator\") and the provider's filters (gender, age, accent, language, use_case). Free; needs the Studio worker with the voice provider. " +
        "Each voice has a preview_url: play previews to the person when it matters. Use a found voice by its voice_id: set_studio_voice (the workspace's narration voice; only its id is stored, the account is unchanged), or voice_id on generate_studio_narration (a cast member's line) and generate_studio_revoice. " +
        'Plain voices: one narrator, one voice per person, one voice for all of a person\'s agents. A voice cloned from a real person only with their say-so.',
      inputSchema: z.object({
        search: z.string().optional().describe('Words that describe the voice'),
        gender: z.string().optional(),
        age: z.string().optional().describe('young, middle_aged, old'),
        accent: z.string().optional().describe('american, british, australian, …'),
        language: z.string().optional().describe('A language code: en, de, fr, …'),
        use_case: z.string().optional().describe('narration, conversational, characters, …'),
        page_size: z.number().int().min(1).max(30).optional().describe('How many (default 12)'),
      }),
      execute: async ({ search, gender, age, accent, language, use_case, page_size }) =>
        withStudio(async (ctx) => {
          const { voices, hasMore } = await (await server()).searchVoices(ctx, { search, gender, age, accent, language, useCase: use_case, pageSize: page_size })
          // A shared library voice's name and description are written by whoever shared it: fenced as data.
          const outside = (v: { source: string }, text: string | undefined) => (v.source === 'library' && text ? wrapUntrusted(text, 'WEB') ?? undefined : text)
          return {
            success: true,
            voices: voices.map((v) => ({
              voice_id: v.voiceId, name: outside(v, v.name), source: v.source,
              ...Object.fromEntries(Object.entries({ gender: v.gender, age: v.age, accent: v.accent, language: v.language, use_case: v.useCase, category: v.category, description: outside(v, v.description), preview_url: v.previewUrl }).filter(([, value]) => value)),
            })),
            ...(hasMore ? { more: true } : {}),
            ...(voices.length ? {} : { note: 'No voice matched: try fewer filters or other words.' }),
          }
        }),
    }),

    quote_studio_revoice: tool({
      description:
        "What re-voicing a stretch of a library recording or generated clip into another voice would cost: the seconds of audio the voice provider bills by, the estimated credits, and whether this exact re-voice is cached (then it is free). Spends nothing. Show the person before generate_studio_revoice. " +
        CONSENT,
      inputSchema: revoiceInput,
      execute: quote('revoice'),
    }),

    generate_studio_revoice: tool({
      description:
        "Re-speak the speech of a library audio or video asset (or the stretch from..to) in another voice with the voice provider's speech to speech, keeping every pause, so a generated talking shot's lip sync holds when its stand-in voice is swapped for the cast voice. " +
        "The result is a new library audio asset; when its length matches the stretch, the source's transcript words are carried over to it (timing_kept). If a name came out mumbled, generate_studio_narration the line in the same voice_id instead. " +
        "A cached re-voice runs at once and costs nothing; one that isn't uses the person's ElevenLabs credits, so it is held for their yes on an approval card and runs only when they accept. " +
        CONSENT + PLACED_NOWHERE + ' ' + MONEY_RULES,
      inputSchema: revoiceInput,
      execute: generate('revoice', GENERATE_STUDIO_REVOICE),
    }),

    quote_studio_sound_effect: tool({
      description:
        'What designed sound effects from a description would cost: the seconds of audio the voice provider bills by (length × candidates), the estimated credits, the terms the provider states, and whether this exact ask is cached (free). Spends nothing. Show the person before generate_studio_sound_effect.',
      inputSchema: soundEffectInput,
      execute: quote('sound-effect'),
    }),

    generate_studio_sound_effect: tool({
      description:
        "Make designed sound effects from a description with the voice provider (a chime for a task done, a whoosh, a room tone), as 1 to 3 candidate library audio assets with their provenance (provider, description, the terms it states). " +
        'Reach for the sound bank first (list_studio_sounds, add_studio_sounds): a designed effect is for a sound the bank lacks. Judge the candidates (judge_studio_sound) before placing one. ' +
        "A cached ask runs at once and costs nothing; one that isn't uses the person's ElevenLabs credits, so it is held for their yes on an approval card. " +
        PLACED_NOWHERE + ' ' + MONEY_RULES,
      inputSchema: soundEffectInput,
      execute: generate('sound-effect', GENERATE_STUDIO_SOUND_EFFECT),
    }),

    quote_studio_music: tool({
      description:
        'What a music bed from a description would cost: the seconds of audio the voice provider bills by (length × candidates), the estimated credits, the licence terms the provider states, and whether this exact ask is cached (free). Spends nothing. Show the person before generate_studio_music.',
      inputSchema: musicInput,
      execute: quote('music'),
    }),

    generate_studio_music: tool({
      description:
        "Make a music bed from a description with the voice provider (instrumental by default), as 1 or 2 candidate library audio assets with their provenance (provider, description, the licence terms it states: check the account's plan allows commercial use before a paid ad). " +
        'Ask for a bed that suits the cut (bright, steady, no ending), generate a little longer than needed, and place it from inside the track. A bed the person already has, or a licensed one, comes first. ' +
        "A cached ask runs at once and costs nothing; one that isn't uses the person's ElevenLabs credits, so it is held for their yes on an approval card. " +
        PLACED_NOWHERE + ' ' + MONEY_RULES,
      inputSchema: musicInput,
      execute: generate('music', GENERATE_STUDIO_MUSIC),
    }),
  }
}
