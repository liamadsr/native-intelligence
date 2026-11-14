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
import { expireCallAudio } from '@/lib/capture-feed/audio-retention'
import { CallNotesLiveError, postExtraction, runOwnerBatch } from './capture-finalizer'
import {
  FED_TAIL_CAP_MS,
  fedNotesStatus,
  finishClosedCapture,
  lockFedNotesAsTheyAre,
  markPassDone,
  writeFedNotes,
  type ClosedCaptureFinished,
  type FedNotesStatus,
  type FedNotesWritten,
} from '@/lib/team-calls/fed-notes'
import { LIVE_TURN_BUSY_MARGIN_SECONDS, LIVE_TURN_LEASE_SECONDS, liveTurnBusy, teamCallLiveAgentOn } from '@/lib/team-calls/live-turns'

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
 *   Where the call recorder took the notes (src/lib/team-calls/fed-notes.ts),
 *   the same finish locks the capture that filled in live instead: no files
 *   to wait for, only the recorder's word that it delivered its last words
 *   (its `end`), checked every FED_POLL, at most FED_TAIL_CAP_MS. The same
 *   event with a captureId finishes one capture its owner closed by hand
 *   while the call went on (ended now, then its end-of-meeting pass), whether
 *   or not notes come on again into a new one.
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
  const closedCapture = (event.data as { captureId?: unknown } | undefined)?.captureId
  if (closedCapture !== undefined) {
    if (!isUuid(closedCapture)) return { status: 'skipped', reason: 'bad_event' }
    return runClosedCaptureFinish(callId, closedCapture, step)
  }

  // The call recorder's notes (src/lib/team-calls/fed-notes.ts): a capture that filled in live.
  const fed = (await step.run('fed', () => fedNotesStatus(getServiceClient(), callId))) as FedNotesStatus
  if (fed.fed) return runFedNotesFinish(callId, fed, step)

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

/** How often the finish of the recorder's notes looks for the recorder's last words (it hears of the end at its next heartbeat, then flushes and says so). */
export const FED_POLL = '5s'
const FED_POLL_ROUNDS = Math.ceil(FED_TAIL_CAP_MS / 5000)

/**
 * The recorder's notes, once the call ended: wait until every producer that
 * was still hearing the call says it delivered its last words (at most
 * FED_TAIL_CAP_MS), lock the capture with its transcript in the order things
 * were said (or leave none when nothing was), then the end-of-meeting pass a
 * recorded meeting gets, as its owner: the batch when anything was said, the
 * title and the index.
 */
async function runFedNotesFinish(callId: string, fed: FedNotesStatus, step: NotesRunContext['step']) {
  if (fed.callStatus !== 'ended') return { status: 'skipped', reason: 'live' }
  if (fed.notesState === 'ready' || fed.notesState === 'silent') return { status: 'skipped', reason: fed.notesState }
  // The recorder's last words: until every producer still hearing the call says it delivered them.
  let waiting = fed.undelivered
  for (let round = 1; round <= FED_POLL_ROUNDS && waiting > 0; round++) {
    await step.sleep(`feed-tail-${round}`, FED_POLL)
    waiting = ((await step.run(`feed-look-${round}`, () => fedNotesStatus(getServiceClient(), callId))) as FedNotesStatus).undelivered
  }
  if (waiting > 0) console.warn(`[team-call-notes] call=${callId} locking with ${waiting} feed(s) that never said they were done`)
  const written = (await step.run('write-feed', () => writeFedNotes(getServiceClient(), callId))) as FedNotesWritten
  if (written.outcome !== 'ready') return { status: written.outcome }
  const { captureId, ownerUserId, workspaceId } = written
  let batch: unknown = 'none'
  if (written.spoke) {
    batch = await runCallBatch(captureId, { workspaceId, ownerId: ownerUserId }, step)
    if (batch === 'in_flight') await step.sleep('let-batch-settle', '11m')
  }
  await step.run('post-extraction', () => postExtraction(getServiceClient(), { captureId, workspaceId, ownerId: ownerUserId, captureProcessed: !written.spoke }))
  await step.run('pass-done', () => markPassDone(getServiceClient(), captureId))
  console.info(`[team-call-notes] call=${callId} capture=${captureId} outcome=written via=recorder batch=${String(batch)}`)
  return { status: 'ready', captureId }
}

/**
 * How many times the finish looks for a live turn still running on the
 * capture, FED_POLL apart: past a whole lease and busy()'s margin after it
 * (each round also sleeps, so the wait outlasts both), since a running turn's
 * tools may write until its lease's end (the run token's notAfter) and a write
 * its finalize began just before that end lands within the margin.
 */
export const LIVE_TURN_SETTLE_ROUNDS = Math.ceil((LIVE_TURN_LEASE_SECONDS + LIVE_TURN_BUSY_MARGIN_SECONDS) / 5) + 2

/**
 * The live agent's last turn on the capture, still running when the call
 * ended (src/lib/team-calls/live-turns.ts): the end-of-meeting pass waits
 * for it, so the turn's writes never land beside or on top of the pass's.
 * No new turn starts once the call ended (655 stops the agent then), and the
 * stop keeps a RUNNING turn's lease, so busy() stays true until the turn
 * gives it back or it runs out (at most LIVE_TURN_LEASE_SECONDS, plus busy()'s
 * margin); past that its tools write nothing (their token stops at the
 * lease's end, and the tool route takes a call only while the lease is held)
 * and the route takes no turn on it. A read that fails counts as busy (the
 * wait is bounded anyway), and the log says so. With the live agent off it
 * still looks once: a lease left by a turn the switch's roll-out cut is
 * waited out the same way; no row to read (655 not applied) waits for nothing.
 */
async function waitForLiveTurn(captureId: string, step: NotesRunContext['step'], prefix = '') {
  const switchOn = teamCallLiveAgentOn()
  let unread = 0
  for (let round = 0; round < LIVE_TURN_SETTLE_ROUNDS; round++) {
    const look = await step.run(`${prefix}live-turn-look-${round}`, () =>
      liveTurnBusy(getServiceClient(), captureId).then(
        (busy) => (busy ? 'busy' : 'free'),
        () => 'unread',
      ),
    )
    if (look === 'free') return
    // With the switch off (turned off, perhaps, while this call was live), a turn cut by the
    // roll-out may still hold its lease: a lease seen is waited out as with it on. One that cannot
    // be read is no lease (655 not applied, or nothing ever ran): the pass runs, as it always did.
    if (!switchOn && round === 0 && look === 'unread') return
    if (look === 'unread') unread++
    await step.sleep(`${prefix}live-turn-wait-${round}`, FED_POLL)
  }
  // Say which it was: the lease could not be read (counted as busy), or a turn held it the whole wait.
  console.warn(
    unread === LIVE_TURN_SETTLE_ROUNDS
      ? `[team-call-notes] capture=${captureId} the live turn's lease could not be read in ${unread} looks; the end-of-meeting pass runs now`
      : `[team-call-notes] capture=${captureId} the end-of-meeting pass runs after waiting out a live turn's lease (${unread} of ${LIVE_TURN_SETTLE_ROUNDS} looks unread)`,
  )
}

/** How many times the finish asks for its batch, each after a wait for the last live turn, while the route answers "not yet". */
export const CALL_BATCH_ATTEMPTS = 3

/**
 * The end-of-meeting pass on a call's capture: wait for its last live turn,
 * then the batch. The live agent's route answers 409 CALL_NOTES_LIVE while a
 * turn still holds the capture's lease (the switch flipped off mid-call, a
 * lease seen only just): that is "not yet", so the finish waits again (a whole
 * lease and its margin each time) and asks again. The first
 * CALL_BATCH_ATTEMPTS - 1 answers of "not yet" are kept as the step's result
 * (memoised: a replay never asks again); on the last attempt the "not yet"
 * escapes its step, so Inngest retries THAT step (the finish's retries: 2),
 * each retry asking the route again. So the route is asked up to
 * CALL_BATCH_ATTEMPTS + 2 times; if every answer is "not yet", the finish
 * fails and its onFailure locks the notes as they are (the recorder's
 * capture) or leaves the pass pending for the sweeper (one closed by hand).
 * A lease ends at most LIVE_TURN_LEASE_SECONDS after the call ended (no turn
 * begins once it has), so the second wait already outlasts any.
 */
async function runCallBatch(captureId: string, args: { workspaceId: string; ownerId: string }, step: NotesRunContext['step']) {
  for (let attempt = 0; attempt < CALL_BATCH_ATTEMPTS; attempt++) {
    const last = attempt === CALL_BATCH_ATTEMPTS - 1
    const prefix = attempt === 0 ? '' : `batch-again-${attempt}-`
    await waitForLiveTurn(captureId, step, prefix)
    const out = await step.run(attempt === 0 ? 'batch' : `batch-again-${attempt}`, async () => {
      try {
        return await runOwnerBatch(getServiceClient(), { captureId, ...args })
      } catch (err) {
        // The last "not yet" escapes the step: Inngest's step retry asks the route again.
        if (err instanceof CallNotesLiveError && !last) return 'not_yet' as const
        throw err
      }
    })
    if (out !== 'not_yet') return out
    console.warn(`[team-call-notes] capture=${captureId} batch not yet (a live turn still holds the lease), attempt ${attempt + 1} of ${CALL_BATCH_ATTEMPTS}`)
  }
  // Unreachable: the last attempt returns its batch or throws from inside its step.
  throw new Error(`team call notes: capture=${captureId} still not free after ${CALL_BATCH_ATTEMPTS} waits`)
}

/** A capture of the call its owner closed by hand: finished now, then the pass a recorded meeting gets, as its owner. */
async function runClosedCaptureFinish(callId: string, captureId: string, step: NotesRunContext['step']) {
  const finished = (await step.run('finish-closed', () => finishClosedCapture(getServiceClient(), captureId))) as ClosedCaptureFinished
  if (finished.outcome !== 'ready') return { status: 'skipped', reason: finished.outcome }
  const { ownerUserId, workspaceId } = finished
  let batch: unknown = 'none'
  if (finished.spoke) {
    batch = await runCallBatch(captureId, { workspaceId, ownerId: ownerUserId }, step)
    if (batch === 'in_flight') await step.sleep('let-batch-settle', '11m')
  }
  await step.run('post-extraction', () => postExtraction(getServiceClient(), { captureId, workspaceId, ownerId: ownerUserId, captureProcessed: !finished.spoke }))
  await step.run('pass-done', () => markPassDone(getServiceClient(), captureId))
  console.info(`[team-call-notes] call=${callId} capture=${captureId} outcome=written via=closed_by_hand batch=${String(batch)}`)
  return { status: 'ready', captureId }
}

/** The finish gave out (its retries spent): the notes are failed, every file's audio kept; the recorder's capture is locked as it stands. */
export async function teamCallNotesFinishFailed({ event }: { event: { data?: { event?: { data?: unknown } | null } | null } }) {
  const callId = (event?.data?.event?.data as { callId?: unknown } | undefined)?.callId
  if (!isUuid(callId)) return { skipped: 'bad_event' }
  const closedCapture = (event?.data?.event?.data as { captureId?: unknown } | undefined)?.captureId
  if (closedCapture !== undefined) {
    // A capture closed by hand: ended at least. Its pass is not marked done, so the sweeper asks for
    // it again (a bounded number of times, each a fresh event).
    if (isUuid(closedCapture)) await finishClosedCapture(getServiceClient(), closedCapture).catch(() => null)
    console.warn(`[team-call-notes] call=${callId} capture=${String(closedCapture)} outcome=ended_pass_pending via=closed_by_hand reason=retries_spent`)
    return { failed: callId }
  }
  const fed = await fedNotesStatus(getServiceClient(), callId)
  if (fed.fed) {
    const locked = await lockFedNotesAsTheyAre(getServiceClient(), callId)
    console.warn(`[team-call-notes] call=${callId} outcome=locked_as_is via=recorder reason=retries_spent result=${locked}`)
    return { failed: callId }
  }
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
 * rows are gone. Then, in a step of its own (one failing never holds up the
 * other), the call recorder's audio files past their 30 days
 * (src/lib/capture-feed/audio-retention.ts). Bounded per run.
 */
export const teamCallNotesRetention = inngest.createFunction(
  {
    id: 'team-call-notes-retention',
    retries: 1,
    singleton: { mode: 'skip' },
    triggers: [{ cron: '17 4 * * *' }],
  },
  async ({ step }) => {
    const sweep = await step.run('sweep', () => sweepCallAudio(getServiceClient()))
    const audioFiles = await step.run('call-audio-files', () => expireCallAudio(getServiceClient()))
    return { sweep, audioFiles }
  },
)
