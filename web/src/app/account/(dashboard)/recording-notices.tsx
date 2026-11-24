'use client'

/**
 * What a Studio take says when no Studio is on screen: "Recording saved", with Open in Studio, or what needs
 * attention. The take lives in the page's recording controller (components/studio/record/controller.ts), which posts
 * here through lib/studio/recording-bus.ts; this file never imports the Studio, so the shell stays as small as it was.
 * A notice only ever comes after a take stopped (never while one records: a display take would have it in its video).
 *
 * Two more things the shell does for a take:
 *   - on the Mac, when the app has takes left to send from before (a quit, a crash, a reload mid-take), the controller
 *     is loaded after a while to send and file them, and says so here when it has;
 *   - when the account signed in changes under the page, everything of the earlier account's take is forgotten.
 */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { openTarget } from '@/lib/chat-cards/open-card'
import { isDesktopApp } from '@/lib/platform'
import { onRecordingNotice, resetRecording, type RecordingNotice } from '@/lib/studio/recording-bus'
import { createClient } from '@/lib/supabase/client'

/** How long after the page opens a Mac's left-over takes are looked for (out of the way of the page's first work). */
export const LEFT_OVER_AFTER_MS = 8000

export function showRecordingNotice(notice: RecordingNotice): void {
  const open = notice.videoId
    ? { label: 'Open in Studio', onClick: () => { openTarget({ type: 'studio_video', id: notice.videoId!, title: 'Recording' }, { from: 'recording', reuse: true }) } }
    : undefined
  if (notice.tone === 'error') toast.error(notice.text, { id: notice.id, ...(open ? { action: open } : {}) })
  else toast(notice.text, { id: notice.id, ...(open ? { action: open } : {}) })
}

export function RecordingNotices() {
  useEffect(() => onRecordingNotice(showRecordingNotice), [])

  // The Mac app's takes left from before: sent and filed by the controller, loaded only when there are some.
  useEffect(() => {
    if (!isDesktopApp()) return
    let alive = true
    const timer = setTimeout(() => {
      void (async () => {
        const { studioRecorder } = await import('@/lib/tauri-bridge')
        const left = await studioRecorder.unfinishedTakes().catch(() => null)
        if (!alive || !left?.takes.length) return
        const { recordingController } = await import('@/components/studio/record/controller')
        if (alive) void recordingController().open()
      })()
    }, LEFT_OVER_AFTER_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  // Another account signed in on this page (or none): the earlier one's take, notices and handoff are forgotten.
  useEffect(() => {
    let user: string | null | undefined
    const { data } = createClient().auth.onAuthStateChange((_event, session) => {
      const next = session?.user?.id ?? null
      if (user !== undefined && next !== user) resetRecording()
      user = next
    })
    return () => data.subscription.unsubscribe()
  }, [])

  return null
}
