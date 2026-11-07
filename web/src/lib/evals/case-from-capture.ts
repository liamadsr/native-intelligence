/**
 * Seed an eval case from a RECORDED capture: the replay of a real call, so the
 * quiet-by-default sidekick can be measured on the meetings it actually sits in.
 *
 * The capture's stored transcript (`[local_1] text` per line, raw speaker
 * labels) goes through the same parser a pasted transcript does
 * (`parse-transcript.ts`), so the script's labels, streams and synthesized
 * timing follow exactly the rules a paste follows, and the frozen chunks come
 * out of `createEvalCase` as for any other case. The case starts with EMPTY
 * expectations: a person fills in the goal, the moments the agent should speak
 * up and the windows it must stay quiet, in the case editor.
 *
 * THE VISIBILITY FENCE. Only a WORKSPACE-visible capture can become a case.
 * A run's trials and checks (the trace's chunk text, nudge evidence, judge
 * quotes) are readable by every member of the workspace, so a private call
 * replayed as a case would republish its words to all of them, the owner's
 * own private call included. The read runs on the service client, so the
 * capture must also pass `isCaptureVisible` and must not itself be an eval
 * capture. Anything else (another workspace, a private call, a mock) reads as
 * not found, so the refusal says nothing, not even that the capture exists.
 *
 * Participant names come from the capture's own `capture_participant` rows
 * (their `external_name`, by speaker label); the case's participants carry no
 * contact or member links, like every eval participant.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCaptureVisible } from '@/lib/ai/tools/_shared'
import { createEvalCase } from './create-case'
import { SELF_LABEL, parseTranscriptText, toParticipants, toScript } from './parse-transcript'
import type { EvalCaseRow, EvalParticipant } from './types'

export type CaseFromCaptureResult =
  | { ok: true; caseRow: EvalCaseRow }
  | { ok: false; reason: 'not_found' | 'empty_transcript' }

interface SourceCapture {
  id: string
  title: string | null
  transcript: string | null
  visibility: string | null
  user_id: string | null
  is_eval: boolean | null
}

interface SourceParticipant {
  speaker_label: string | null
  external_name: string | null
  is_self: boolean | null
}

/** The speaker whose lines are the person's own microphone: the capture's
 *  self participant's label when it has one, else the raw `local_1`, else
 *  nobody (every voice is then someone else). Pure. */
export function selfSpeakerOf(speakers: string[], participants: SourceParticipant[]): string | null {
  const selfLabel = participants.find((p) => p.is_self && p.speaker_label)?.speaker_label?.trim()
  if (selfLabel && speakers.includes(selfLabel)) return selfLabel
  return speakers.includes(SELF_LABEL) ? SELF_LABEL : null
}

/** The case participants, with the capture's names on them where it has them. Pure. */
export function namedParticipants(
  participants: EvalParticipant[],
  source: SourceParticipant[],
): EvalParticipant[] {
  const names = new Map<string, string>()
  for (const p of source) {
    const label = p.speaker_label?.trim()
    const name = p.external_name?.trim()
    if (label && name) names.set(label, name)
  }
  return participants.map((p) => {
    // `display` is the RAW label the transcript carried (parse-transcript's
    // speakers); the name, when the capture knows one, replaces it.
    const name = names.get(p.display)
    return { ...p, display: name ?? (p.is_self ? 'You' : p.display) }
  })
}

export async function createEvalCaseFromCapture(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    suiteId: string
    captureId: string
    name?: string
  },
): Promise<CaseFromCaptureResult> {
  const [{ data: capture }, { data: participantRows }] = await Promise.all([
    service
      .from('captures')
      .select('id, title, transcript, visibility, user_id, is_eval')
      .eq('id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle<SourceCapture>(),
    service
      .from('capture_participant')
      .select('speaker_label, external_name, is_self')
      .eq('capture_id', args.captureId),
  ])
  // Workspace-visible only (see the header): a private call, even the
  // requester's own, never becomes a case. Eval captures are excluded too (no
  // third argument to isCaptureVisible): a replay of a mock is not a recorded
  // call.
  if (!capture || capture.visibility !== 'workspace' || !isCaptureVisible(capture, args.userId)) {
    return { ok: false, reason: 'not_found' }
  }

  const parsed = parseTranscriptText(capture.transcript ?? '')
  const source = (participantRows ?? []) as SourceParticipant[]
  const self = selfSpeakerOf(parsed.speakers, source)
  const script = toScript(parsed, self)
  if (script.length === 0 || script.every((s) => !s.text.trim())) {
    return { ok: false, reason: 'empty_transcript' }
  }
  // A line the stored format left with no text (a wrapped label alone) has no
  // words to replay, and the case schema refuses an empty segment.
  const spoken = script.filter((s) => s.text.trim())

  const title = capture.title?.trim() || 'Recorded call'
  const caseRow = await createEvalCase(service, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    suiteId: args.suiteId,
    name: (args.name?.trim() || `${title} (replay)`).slice(0, 200),
    script: spoken,
    participants: namedParticipants(toParticipants(parsed, self), source),
    expected: {},
    // Nudges are a live-only dimension, and a real call is what the live
    // replay is for.
    modes: ['live'],
    seededFromCaptureId: capture.id,
  })
  return { ok: true, caseRow }
}
