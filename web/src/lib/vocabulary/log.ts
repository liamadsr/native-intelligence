/**
 * The vocabulary's debug log (Liam, 2026-10-25: "add logging so we can see
 * exactly what happens and do real comparison"). Each corrected utterance
 * writes a few lines into the desktop's debug log (`native-intelligence-debug.log` in the
 * Mac's temp folder, through `voice_log`), and into the console on the web:
 *
 *   [voice-focus] dict-… vocab ready: 2431 terms (v1a2b3c), workspace aa5dc58b
 *   [voice-focus] dict-… vocab heard: I think we need the APAM team
 *   [voice-focus] dict-… vocab wrote: I think we need the APIM team
 *   [voice-focus] dict-… vocab fixed: "APAM" → APIM (sound 0.90)
 *   [voice-focus] dict-… vocab near: "api am" → APIM 0.87, left alone (ordinary words)
 *
 * Or, when nothing could be corrected, why ("vocab off: not loaded yet (compile
 * 500)"). Dictated text goes into a local file on the person's own Mac only.
 * Meetings log only the segments with a fix or a near miss.
 */
import type { Correction, NearMiss } from './sound-match'

export type VocabularySurface = 'dictation' | 'voice' | 'meeting' | 'anywhere'

export interface VocabularyLogContext {
  surface: VocabularySurface
  /** The voice session's id (dict-…, conv-…), so the lines sit with the desktop's own. */
  sessionId?: string
}

export interface CorrectorState {
  ready: boolean
  terms: number
  version: string | null
  workspaceId: string | null
  /** Why there is no corrector, when there isn't one. */
  problem: string | null
}

const PIECE = 330

/** A long text in pieces that fit one log line each. */
function pieces(label: string, text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= PIECE) return [`${label}: ${flat}`]
  const out: string[] = []
  for (let i = 0, k = 1; i < flat.length; i += PIECE, k++) out.push(`${label} (${k}): ${flat.slice(i, i + PIECE)}`)
  return out
}

/** The lines for one utterance. Pure. */
export function vocabularyLogLines(args: {
  state: CorrectorState
  heard: string
  wrote: string
  corrections: readonly Correction[]
  nearMisses: readonly NearMiss[]
}): string[] {
  const { state } = args
  const lines: string[] = []
  if (!state.ready) {
    lines.push(`vocab off: ${state.problem ?? 'not loaded yet'}`)
    lines.push(...pieces('vocab heard', args.heard))
    return lines
  }
  lines.push(`vocab ready: ${state.terms} terms (v${state.version ?? '?'}), workspace ${(state.workspaceId ?? '?').slice(0, 8)}`)
  lines.push(...pieces('vocab heard', args.heard))
  if (args.wrote !== args.heard) lines.push(...pieces('vocab wrote', args.wrote))
  for (const c of args.corrections) {
    lines.push(`vocab fixed: "${c.from}" → ${c.to} (${c.kind}${c.score !== undefined ? ` ${c.score.toFixed(2)}` : ''})`)
  }
  for (const m of args.nearMisses.slice(0, 8)) {
    lines.push(`vocab near: "${m.from}" → ${m.to} ${m.score.toFixed(2)}, left alone (${m.reason})`)
  }
  if (!args.corrections.length && !args.nearMisses.length) lines.push('vocab: nothing close to a term')
  return lines
}

/** Write the lines: the desktop's debug log when in the desktop app, the console otherwise. Never throws. */
export function writeVocabularyLog(ctx: VocabularyLogContext, lines: readonly string[]) {
  if (!lines.length || typeof window === 'undefined') return
  const sid = ctx.sessionId || `vocab-${ctx.surface}`
  void Promise.all([import('@/lib/tauri-bridge'), import('@/lib/platform')])
    .then(async ([{ tauriBridge }, { isDesktopApp }]) => {
      if (isDesktopApp()) {
        for (const line of lines) await tauriBridge.voiceLog(sid, line)
      } else {
        for (const line of lines) console.info(`[vocabulary] ${sid} ${line}`)
      }
    })
    .catch(() => {})
}
