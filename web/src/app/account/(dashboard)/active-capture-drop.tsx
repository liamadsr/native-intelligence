'use client'

/**
 * During a live capture, files dropped anywhere in the app that isn't a drop
 * zone of its own attach to the capture being recorded. The zones
 * (`data-file-drop-zone`) keep theirs: the chat box sends them to its chat, a
 * capture's, an action's or a project's panel attaches them there. While files
 * are dragged over the rest of the app, the window says where they'll go.
 *
 * With no live capture, files dropped outside a zone do nothing, and must
 * never make the browser navigate to them: in the desktop WebView that
 * replaces the whole app.
 *
 * Also relays the desktop's word that a capture's attachments changed in
 * another window (the agent HUD takes files for the call's capture) to this
 * window's panels.
 */
import { useEffect, useRef, useState } from 'react'
import { Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import { announceCaptureAttachments, dragHasFiles, dropZoneOf, filesFromTransfer } from '@/lib/attachments/dropped-files'
import { tauriBridge } from '@/lib/tauri-bridge'

export function ActiveCaptureDrop() {
  const recording = useOptionalRecordingStable()
  const liveCaptureId = recording && (recording.isRecording || recording.isStarting) ? recording.captureId : null
  const liveRef = useRef(liveCaptureId)
  liveRef.current = liveCaptureId
  const [overApp, setOverApp] = useState(false)

  useEffect(() => {
    // The capture phase, before any zone (one may stop the drag): every file
    // drag is taken, so no drop anywhere loads the file in place of the app;
    // and the hint follows the files. Enter and leave fire per element, so
    // the window is left when every enter has had its leave.
    let depth = 0
    const track = (e: DragEvent) => {
      setOverApp(!!liveRef.current && !dropZoneOf(e.target))
    }
    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      depth++
      track(e)
    }
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOverApp(false)
    }
    const onTakeOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      track(e)
    }
    const onTakeDrop = (e: DragEvent) => {
      depth = 0
      setOverApp(false)
      if (dragHasFiles(e.dataTransfer)) e.preventDefault()
    }
    const onEnd = () => {
      depth = 0
      setOverApp(false)
    }
    // The bubble phase, for what no zone stopped: a zone's own (the project
    // panel's, which lets the drop go on) stays its own.
    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer) || dropZoneOf(e.target)) return
      if (liveRef.current && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer) || dropZoneOf(e.target)) return
      const captureId = liveRef.current
      const files = filesFromTransfer(e.dataTransfer)
      if (captureId && files.length > 0) void attachToCapture(captureId, files)
    }
    window.addEventListener('dragenter', onEnter, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('dragover', onTakeOver, true)
    window.addEventListener('drop', onTakeDrop, true)
    window.addEventListener('dragend', onEnd, true)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('dragover', onTakeOver, true)
      window.removeEventListener('drop', onTakeDrop, true)
      window.removeEventListener('dragend', onEnd, true)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => tauriBridge.captureAttachments.onChanged(announceCaptureAttachments), [])

  if (!overApp || !liveCaptureId) return null
  return (
    <div
      data-active-capture-drop=""
      className="pointer-events-none fixed inset-2 z-[100] flex items-center justify-center rounded-xl border-2 border-dashed border-primary/50 bg-primary/5"
    >
      <div className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-sm font-medium text-primary/80 shadow-sm">
        <Paperclip className="h-4 w-4" />
        Drop to attach to the live capture
      </div>
    </div>
  )
}

async function attachToCapture(captureId: string, files: File[]): Promise<void> {
  const one = files.length === 1 ? files[0].name : null
  const id = toast.loading(one ? `Attaching ${one}…` : `Attaching ${files.length} files…`)
  const { uploaded, firstError } = await uploadAttachments(files, { noteId: captureId })
  if (uploaded > 0) {
    announceCaptureAttachments(captureId)
    const what = one ?? `${uploaded} file${uploaded === 1 ? '' : 's'}`
    toast.success(`Attached ${what} to the live capture`, { id })
    if (firstError) toast.error(firstError)
  } else {
    toast.error(firstError ?? 'Upload failed. Please try again.', { id })
  }
}
