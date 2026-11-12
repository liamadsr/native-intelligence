/**
 * The approval cards for the two Studio tools that spend the person's own provider credits
 * (src/lib/ai/tools/studio-media.ts), for the outward gate (src/lib/safety/outward-gate.ts): it holds every such
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
 *                               the card and the Accept, the replay spends nothing.
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
  const fallback: SpendCard = {
    title: 'Generate narration with ElevenLabs credits?',
    why: `This makes narration in the workspace's voice on your ElevenLabs account, which uses credits (one per character). ${AFTER}`,
  }
  if (!args.userId || typeof text !== 'string') return fallback
  try {
    const ctx = await studioContext(getServiceClient(), args.userId, args.workspaceId)
    if (isRefusal(ctx)) return fallback
    const { previewNarration } = await import('@/lib/studio/server/voiceover')
    const preview = await previewNarration(ctx, text)
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
