import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { isUuid } from '@/lib/team-chat/types'
import { liveKitEgress, teamCallEgressConfig } from '@/lib/team-calls/egress'
import {
  TEAM_CALL_NOTES_FILE_EVENT,
  TEAM_CALL_NOTES_FINISH_EVENT,
  TEAM_CALL_NOTES_STOP_EVENT,
  giveUpOnNotes,
  markTranscript,
  notesStatus,
  removeNotesAudio,
  requestNotesFiles,
  settleNotes,
  stopEgresses,
  transcribeNotesFile,
  writeNotes,
  type NotesStatus,
  type NotesWritten,
} from '@/lib/team-calls/notes-store'
import { sweepCallAudio } from '@/lib/team-calls/notes-retention'
import { postExtraction, runOwnerBatch } from './capture-finalizer'

/**
 * A call's notes, after the call (calls plan, phase 6; src/lib/team-calls/
 * notes-store.ts has the parts):
 *
 *   team-calls/notes.file   → one microphone's file transcribed (Deepgram,
 *     prerecorded). Sent when its egress ends (the webhook: a person who
 *     left has theirs done while the call goes on) and again by the finish
 *     (the event id dedupes). Deepgram failing is retried (3 times, Inngest's
 *     backoff); after that the file is failed and its audio kept.
 *   team-calls/notes.finish → once the call ended: wait for every egress to
 *     finish and every file's words (FINISH_ROUNDS × FINISH_WAIT, about 15
 *     minutes; egresses still running halfway are asked to stop), then give
 *     up on what never came (failed, audio kept), write the notes (one
 *     capture, or nothing when nothing was said), run the end-of-meeting
 *     batch on it as a recorded meeting's (summary, action items, claims,
 *     as its owner), name nothing (its title is the conversation's), index
 *     it, and remove the audio whose words are in.
 *
 * One `[team-call-notes]` line per step outcome, ids only.
 */

/** What these read of Inngest's run (a test hands its own). */
export interface NotesRunContext {
  event: { data: unknown }
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
    sleep: (id: string, duration: string) => Promise<unknown>
  }
}

export async function runTeamCallNotesFile({ event, step }: NotesRunContext) {
  const rowId = (event.data as { rowId?: unknown } | undefined)?.rowId
  if (!isUuid(rowId)) return { status: 'skipped', reason: 'bad_event' }
  const outcome = await step.run('transcribe', () => transcribeNotesFile(getServiceClient(), rowId))
  return { status: 'done', outcome }
}

/** Retries spent: the file is failed (its audio is kept), and the notes say whose words are missing. */
export async function teamCallNotesFileFailed({ event }: { event: { data?: { event?: { data?: unknown } | null } | null } }) {
  const rowId = (event?.data?.event?.data as { rowId?: unknown } | undefined)?.rowId
  if (!isUuid(rowId)) return { skipped: 'bad_event' }
  await markTranscript(getServiceClient(), rowId, 'failed', null)
  console.warn(`[team-call-notes] egress_row=${rowId} outcome=failed reason=retries_spent`)
  return { failed: rowId }
}

export const teamCallNotesFile = inngest.createFunction(
  {
    id: 'team-call-notes-file',
    retries: 3,
    concurrency: [{ limit: 4 }],
    onFailure: (ctx: unknown) => teamCallNotesFileFailed(ctx as Parameters<typeof teamCallNotesFileFailed>[0]),
    triggers: [{ event: TEAM_CALL_NOTES_FILE_EVENT }],
  },
  runTeamCallNotesFile,
)

/** How many times the finish looks, and how long it waits between. */
export const FINISH_ROUNDS = 30
export const FINISH_WAIT = '30s'

export async function runTeamCallNotesFinish({ event, step }: NotesRunContext) {
  const callId = (event.data as { callId?: unknown } | undefined)?.callId
  if (!isUuid(callId)) return { status: 'skipped', reason: 'bad_event' }

  let progress = (await step.run('look-0', () => notesStatus(getServiceClient(), callId))) as NotesStatus
  if (progress.callStatus !== 'ended' || progress.notesState !== 'transcribing') {
    return { status: 'skipped', reason: progress.notesState ?? 'no_call' }
  }
  for (let round = 1; round <= FINISH_ROUNDS && !progress.settled; round++) {
    if (progress.pending.length > 0) {
      const pending = progress.pending
      await step.run(`ask-files-${round}`, () => requestNotesFiles(pending))
    }
    if (round === Math.ceil(FINISH_ROUNDS / 2) && progress.running.length > 0) {
      // Halfway and still running (their end never came): ask LiveKit to stop them.
      await step.run('stop-leftovers', async () => {
        const config = teamCallEgressConfig()
        return config ? stopEgresses(getServiceClient(), liveKitEgress(config), callId, 'notes') : 0
      })
    }
    await step.sleep(`wait-${round}`, FINISH_WAIT)
    progress = (await step.run(`look-${round}`, () => notesStatus(getServiceClient(), callId))) as NotesStatus
  }
  if (!progress.settled) {
    const last = progress
    await step.run('give-up', () => giveUpOnNotes(getServiceClient(), last))
  }

  const written = (await step.run('write', () => writeNotes(getServiceClient(), callId))) as NotesWritten
  if (written.outcome !== 'ready') {
    if (written.outcome === 'silent') await step.run('remove-audio', () => removeNotesAudio(getServiceClient(), callId))
    return { status: written.outcome }
  }
  const { captureId, ownerUserId, workspaceId } = written
  // The end-of-meeting pass a recorded meeting gets (summary, actions, claims), as the notes' owner.
  const batch = await step.run('batch', () => runOwnerBatch(getServiceClient(), { captureId, workspaceId, ownerId: ownerUserId }))
  if (batch === 'in_flight') await step.sleep('let-batch-settle', '11m')
  await step.run('post-extraction', () => postExtraction(getServiceClient(), { captureId, workspaceId, ownerId: ownerUserId, captureProcessed: false }))
  const removed = await step.run('remove-audio', () => removeNotesAudio(getServiceClient(), callId))
  console.info(`[team-call-notes] call=${callId} capture=${captureId} outcome=written batch=${batch} audio_removed=${removed}`)
  return { status: 'ready', captureId }
}

/** The finish gave out (its retries spent): the notes are failed, every file's audio kept. */
export async function teamCallNotesFinishFailed({ event }: { event: { data?: { event?: { data?: unknown } | null } | null } }) {
  const callId = (event?.data?.event?.data as { callId?: unknown } | undefined)?.callId
  if (!isUuid(callId)) return { skipped: 'bad_event' }
  const settled = await settleNotes(getServiceClient(), callId, 'failed')
  console.warn(`[team-call-notes] call=${callId} outcome=failed reason=retries_spent settled=${settled}`)
  return { failed: callId }
}

export const teamCallNotesFinish = inngest.createFunction(
  {
    id: 'team-call-notes-finish',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.callId' }],
    onFailure: (ctx: unknown) => teamCallNotesFinishFailed(ctx as Parameters<typeof teamCallNotesFinishFailed>[0]),
    triggers: [{ event: TEAM_CALL_NOTES_FINISH_EVENT }],
  },
  runTeamCallNotesFinish,
)

/**
 * team-calls/notes.stop → a call's notes went off: its running egresses are
 * stopped, retried until LiveKit takes every stop (a failed stop throws).
 * The sweeper stops any egress whose notes are off on each run too, and the
 * notes keep no word said after the moment they went off (567's cutoff), so
 * a late stop never leaks into them.
 */
export async function runTeamCallNotesStop({ event, step }: Pick<NotesRunContext, 'event'> & { step: Pick<NotesRunContext['step'], 'run'> }) {
  const callId = (event.data as { callId?: unknown } | undefined)?.callId
  if (!isUuid(callId)) return { status: 'skipped', reason: 'bad_event' }
  const stopped = await step.run('stop', async () => {
    const config = teamCallEgressConfig()
    return config ? stopEgresses(getServiceClient(), liveKitEgress(config), callId, 'notes', { strict: true }) : 0
  })
  return { status: 'done', stopped }
}

export const teamCallNotesStop = inngest.createFunction(
  {
    id: 'team-call-notes-stop',
    retries: 5,
    concurrency: [{ limit: 1, key: 'event.data.callId' }],
    triggers: [{ event: TEAM_CALL_NOTES_STOP_EVENT }],
  },
  runTeamCallNotesStop,
)

/**
 * Every day, how long call audio is kept (src/lib/team-calls/notes-retention.ts):
 * raw notes audio whose words are in is removed (recorded calls too), audio
 * whose words could not be read after a week, and the files of calls whose
 * rows are gone. Bounded per run.
 */
export const teamCallNotesRetention = inngest.createFunction(
  {
    id: 'team-call-notes-retention',
    retries: 1,
    singleton: { mode: 'skip' },
    triggers: [{ cron: '17 4 * * *' }],
  },
  async ({ step }) => step.run('sweep', () => sweepCallAudio(getServiceClient())),
)
