/**
 * The meeting agent's background work (roadmap #12,
 * docs/plans/agent-joins-meetings.md). Liam, 11-27: "let's do it".
 *
 *   meeting-agent-dial    on `meeting-agent/scheduled` (a send): sleeps until
 *                         a minute before the start, then dials once
 *                         (src/lib/meeting-agent/dial.ts checks everything
 *                         again then). A cancel (`meeting-agent/cancelled`)
 *                         stops the sleep; a meeting sent again with a new
 *                         start is a new run, and the old one finds the start
 *                         moved and does nothing.
 *   meeting-agent-notes   on `meeting-agent/notes.ready` (the call ended with
 *                         words: src/lib/meeting-agent/finish.ts): the end of
 *                         meeting pass a recorded meeting gets, as the person
 *                         (summary, action items, decisions, then title and
 *                         index).
 */
import { getServiceClient } from '@/lib/admin'
import { dialAttendance } from '@/lib/meeting-agent/dial'
import { MEETING_NOTES_READY_EVENT, type MeetingNotesReadyData } from '@/lib/meeting-agent/finish'
import { MEETING_CANCELLED_EVENT, MEETING_SCHEDULED_EVENT, type MeetingScheduledData } from '@/lib/meeting-agent/send'
import { postExtraction, runOwnerBatch } from './capture-finalizer'
import { inngest } from './client'

/** How long before the start it dials (a phone bridge opens a few minutes early; a host joining sees it waiting). */
export const DIAL_LEAD_MS = 60_000

export const meetingAgentDial = inngest.createFunction(
  {
    id: 'meeting-agent-dial',
    retries: 2,
    cancelOn: [{ event: MEETING_CANCELLED_EVENT, match: 'data.attendanceId' }],
    triggers: [{ event: MEETING_SCHEDULED_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as MeetingScheduledData
    const at = Date.parse(data.startsAt) - DIAL_LEAD_MS
    if (Number.isFinite(at) && at > Date.now()) await step.sleepUntil('until-the-start', new Date(at))
    const outcome = await step.run('dial', () => dialAttendance(getServiceClient(), { attendanceId: data.attendanceId, startsAt: data.startsAt }))
    return { outcome }
  },
)

export const meetingAgentNotes = inngest.createFunction(
  {
    id: 'meeting-agent-notes',
    retries: 3,
    concurrency: [{ limit: 1, key: 'event.data.captureId' }],
    triggers: [{ event: MEETING_NOTES_READY_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as MeetingNotesReadyData
    const args = { captureId: data.captureId, workspaceId: data.workspaceId, ownerId: data.userId }
    const batch = await step.run('batch', () => runOwnerBatch(getServiceClient(), args))
    if (batch === 'in_flight') await step.sleep('let-batch-settle', '11m')
    await step.run('post-extraction', () => postExtraction(getServiceClient(), { ...args, captureProcessed: false }))
    console.info(`[meeting-agent] attendance=${data.attendanceId} capture=${data.captureId} notes finished batch=${batch}`)
    return { batch }
  },
)
