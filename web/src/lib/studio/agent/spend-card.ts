/**
 * The approval cards for the Studio tools that spend the person's own provider credits
 * (src/lib/ai/tools/studio-media.ts, studio-audio.ts), for the outward gate (src/lib/safety/outward-gate.ts): it holds every such
 * call for the person's yes, whoever asked and whatever the reviewer's mode, and the tools themselves refuse to
 * spend outside the replay of that card.
 *
 *   generate_studio_shot        always a card: the model and the credits come from the call's own input, so the
 *                               input hash pins the price the person saw; the replay spends only when a fresh quote
 *                               is that model at no more credits. The hash of what the beat asks of the provider
 *                               (prompt, references, parameters, model: generation.ts shotAskHash) rides on the
 *                               approval, and the replay spends nothing when the beat asks anything else by then.
 *   generate_studio_narration   a card only when the narration is not cached (a cached one costs nothing and runs):
 *                               the voice and the character count, read now. When that can't be read, a card
 *                               anyway (fail closed). The request's hash (text, voice, model, substitutions:
 *                               voiceover.ts) rides on the approval: the voice or its substitutions changed between
 *                               the card and the Accept, the replay spends nothing. A cast member's line names its
 *                               voice (voice_id), read the same way.
 *   generate_studio_revoice,    a card unless this exact request is cached: what the provider bills by (seconds of
 *   generate_studio_sound_effect, audio) and the Studio's estimate of the credits, read now from the server's quote
 *   generate_studio_music       (voice-media.ts), the consent rule (re-voice) or the terms the provider states (sound
 *                               effects, music). The request's hash rides on the approval, as a narration's does.
 *
 * A card without that hash (the request couldn't be read when it was made) is still a card, but its replay refuses:
 * the tools spend only a request the person was shown.
 */
import { getServiceClient } from '@/lib/admin'
import type { StudioSpendApprovalContext } from '@/lib/safety/approved-call'
import { isRefusal, studioContext } from './access'

export const GENERATE_STUDIO_SHOT = 'generate_studio_shot'
export const GENERATE_STUDIO_NARRATION = 'generate_studio_narration'

export type SpendCard = { title: string; why: string; context?: StudioSpendApprovalContext }

const AFTER = 'It runs once, with exactly the inputs below, when you accept. A decline is an answer: nothing is spent.'

/** generate_studio_shot's card, from its input. Pure. */
export function shotCard(input: unknown): SpendCard {
  const i = (input && typeof input === 'object' ? input : {}) as { what?: unknown; final?: unknown; model?: unknown; credits?: unknown; beat_id?: unknown }
  const what = `${i.final === true ? 'final' : 'draft'} ${i.what === 'clip' ? 'clip' : 'still'}`
  const credits = typeof i.credits === 'number' ? i.credits : '?'
  return {
    title: `Spend ${credits} Higgsfield credits on a ${what}?`,
    why: `This generates a ${what} for beat ${String(i.beat_id ?? '?').slice(0, 100)} with ${String(i.model ?? '?').slice(0, 80)} on your Higgsfield account, at no more than ${credits} credits (the price is checked again first). ${AFTER}`,
  }
}

/** generate_studio_shot's card with the hash of what the beat asks of the provider now (without it when that can't be read). */
export async function shotSpendCard(args: { workspaceId: string; userId?: string; input: unknown }): Promise<SpendCard> {
  const card = shotCard(args.input)
  const i = (args.input && typeof args.input === 'object' ? args.input : {}) as { video_id?: unknown; beat_id?: unknown; what?: unknown; final?: unknown; model?: unknown; credits?: unknown }
  if (!args.userId || typeof i.video_id !== 'string' || typeof i.beat_id !== 'string') return card
  try {
    const ctx = await studioContext(getServiceClient(), args.userId, args.workspaceId)
    if (isRefusal(ctx)) return card
    const { shotRequestHash } = await import('@/lib/studio/server/generation')
    const hash = await shotRequestHash(ctx, i.video_id, i.beat_id, { what: i.what, final: i.final === true, confirm: { model: i.model, credits: i.credits } })
    return { ...card, context: { kind: 'shot', request_hash: hash, ...(typeof i.credits === 'number' ? { credits: i.credits } : {}) } }
  } catch {
    return card
  }
}

/** generate_studio_narration's card, or null when this exact narration is cached (it costs nothing). */
export async function narrationCard(args: { workspaceId: string; userId?: string; input: unknown }): Promise<SpendCard | null> {
  const text = (args.input as { text?: unknown } | null)?.text
  const voiceId = (args.input as { voice_id?: unknown } | null)?.voice_id
  const fallback: SpendCard = {
    title: 'Generate narration with ElevenLabs credits?',
    why: `This makes narration in the workspace's voice on your ElevenLabs account, which uses credits (one per character). ${AFTER}`,
  }
  if (!args.userId || typeof text !== 'string') return fallback
  try {
    const ctx = await studioContext(getServiceClient(), args.userId, args.workspaceId)
    if (isRefusal(ctx)) return fallback
    const { previewNarration } = await import('@/lib/studio/server/voiceover')
    const preview = await previewNarration(ctx, text, typeof voiceId === 'string' && voiceId ? { voiceId } : {})
    if (preview.cached) return null
    return {
      title: `Generate ${preview.characters} characters of narration with ElevenLabs?`,
      why: `This makes narration in ${preview.voiceName}'s voice on your ElevenLabs account, about ${preview.characters} credits. ${AFTER}`,
      context: { kind: 'narration', request_hash: preview.requestHash, characters: preview.characters },
    }
  } catch {
    return fallback
  }
}

// ---- the voice provider's re-voice, sound effects and music beds (src/lib/ai/tools/studio-audio.ts) ------------------

export const GENERATE_STUDIO_REVOICE = 'generate_studio_revoice'
export const GENERATE_STUDIO_SOUND_EFFECT = 'generate_studio_sound_effect'
export const GENERATE_STUDIO_MUSIC = 'generate_studio_music'

/** Each spending tool's kind of spend. */
export const PAID_AUDIO_TOOLS: Record<string, 'revoice' | 'sound-effect' | 'music'> = {
  [GENERATE_STUDIO_REVOICE]: 'revoice',
  [GENERATE_STUDIO_SOUND_EFFECT]: 'sound-effect',
  [GENERATE_STUDIO_MUSIC]: 'music',
}

/** The basis the provider bills these by, said on every card. */
const BY_LENGTH = 'ElevenLabs bills this by the length of the audio'

/** The words a tool's input becomes on the server (voice-media.ts takes the editor's names). Pure. */
export function paidAudioBody(kind: 'revoice' | 'sound-effect' | 'music', input: unknown): Record<string, unknown> {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (kind === 'revoice') return { assetId: i.asset_id, from: i.from, to: i.to, voiceId: i.voice_id, speaker: i.speaker, removeBackgroundNoise: i.remove_background_noise }
  if (kind === 'sound-effect') return { text: i.description, seconds: i.seconds, influence: i.influence, loop: i.loop, variants: i.variants, take: i.take }
  return { prompt: i.description, seconds: i.seconds, instrumental: i.instrumental, variants: i.variants, take: i.take }
}

/** A card's words for a quote of each kind. Pure. */
export function paidAudioCopy(kind: 'revoice' | 'sound-effect' | 'music', q: { seconds: number; estimatedCredits: number; terms: string; variants?: number; voiceName?: string; voiceCategory?: string; sourceName?: string; from?: number; to?: number; speaker?: string }): { title: string; why: string } {
  const cost = `${BY_LENGTH}: ${q.seconds} seconds, about ${q.estimatedCredits} credits (an estimate; the costs record ElevenLabs’ own count when it gives one).`
  if (kind === 'revoice') {
    const whose = q.speaker === 'person-who-agreed' ? 'You said this is a real person who agreed to be re-voiced.' : 'You said this speech is a generated voice, not a real person.'
    const cloned = q.voiceCategory === 'cloned' || q.voiceCategory === 'professional' ? ` ${q.voiceName ?? 'This voice'} is cloned from a real person: use it only with their say-so.` : ''
    return {
      title: `Re-voice ${q.seconds} seconds into ${String(q.voiceName ?? 'another voice').slice(0, 60)} with ElevenLabs?`,
      why: `This re-speaks ${String(q.sourceName ?? 'the recording').slice(0, 100)} from ${q.from ?? 0} s to ${q.to ?? 0} s in ${String(q.voiceName ?? 'the chosen voice').slice(0, 60)}'s voice on your ElevenLabs account, keeping its timing. ${cost} A real person’s voice is re-voiced only with their say-so. ${whose}${cloned} ${AFTER}`,
    }
  }
  const what = kind === 'music' ? 'music bed' : 'sound effect'
  const n = q.variants ?? 1
  return {
    title: `Generate ${n} ${what}${n === 1 ? '' : 's'} (${q.seconds} seconds of audio) with ElevenLabs?`,
    why: `This makes ${n} candidate ${what}${n === 1 ? '' : 's'} from your description on your ElevenLabs account, kept in the library and placed nowhere. ${cost} ${q.terms} ${AFTER}`,
  }
}

/**
 * A re-voice's, sound effects' or music bed's card, or null when this exact request is cached (it costs nothing). Read
 * now from the server's own quote; when that can't be read, a card anyway without the pinned request (its replay
 * refuses: the tools spend only a request the person was shown).
 */
export async function paidAudioCard(tool: string, args: { workspaceId: string; userId?: string; input: unknown }): Promise<SpendCard | null> {
  const kind = PAID_AUDIO_TOOLS[tool] ?? 'sound-effect'
  const fallback: SpendCard = {
    title: kind === 'revoice' ? 'Re-voice speech with ElevenLabs credits?' : `Generate ${kind === 'music' ? 'music' : 'sound effects'} with ElevenLabs credits?`,
    why: `This uses your ElevenLabs credits; ${BY_LENGTH}. ${AFTER}`,
  }
  if (!args.userId) return fallback
  try {
    const ctx = await studioContext(getServiceClient(), args.userId, args.workspaceId)
    if (isRefusal(ctx)) return fallback
    const { previewPaid } = await import('@/lib/studio/server/voice-media')
    const quote = await previewPaid(ctx, kind, paidAudioBody(kind, args.input))
    if (quote.cached) return null
    return { ...paidAudioCopy(kind, quote), context: { kind, request_hash: quote.requestHash, seconds: quote.seconds, credits: quote.estimatedCredits } }
  } catch {
    return fallback
  }
}
