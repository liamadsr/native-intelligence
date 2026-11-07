/**
 * Files out of a drop or a paste, and the word that a capture's attachments
 * changed.
 *
 * Where a file dropped during a live capture goes: the chat box sends it to
 * the agent, a capture's (or action's, project's) own panel attaches it there,
 * and anywhere else in the app attaches it to the capture being recorded
 * (active-capture-drop.tsx). The agent HUD's window takes it for the call's
 * capture too (app/hud/agent).
 */

/** An element that takes its own file drops. The innermost one owns a drop. */
export const FILE_DROP_ZONE = '[data-file-drop-zone]'

/** The innermost drop zone an event landed in, if any. */
export function dropZoneOf(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.(FILE_DROP_ZONE) ?? null
}

/** Whether a drag carries files (not text or a link). */
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files')
}

/**
 * The files in a drop or a paste. `files` is the list browsers fill; a drag
 * from some sources (a screenshot's thumbnail, an image dragged out of another
 * app) can leave it empty while its items still hold the file, so those are
 * read too. A file with no name (a pasted or dragged screenshot) gets one: an
 * attachment needs its extension.
 */
export function filesFromTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  let files = Array.from(dt.files ?? [])
  if (files.length === 0 && dt.items) {
    files = Array.from(dt.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)
  }
  const stamp = Date.now()
  return files.map((file, i) => {
    if (file.name) return file
    const ext = (file.type.split('/')[1] || 'png').split('+')[0].toLowerCase()
    return new File([file], `screenshot-${stamp}${i > 0 ? `-${i}` : ''}.${ext}`, {
      type: file.type || 'image/png',
    })
  })
}

/** Window event: a capture's attachments changed (its panels refetch them). */
export const CAPTURE_ATTACHMENTS_EVENT = 'dial8:capture-attachments-changed'

export function announceCaptureAttachments(captureId: string): void {
  window.dispatchEvent(new CustomEvent(CAPTURE_ATTACHMENTS_EVENT, { detail: { captureId } }))
}

/** The capture id in a CAPTURE_ATTACHMENTS_EVENT's detail (or a desktop event's payload). */
export function readAttachmentsCaptureId(detail: unknown): string | null {
  const id = (detail as { captureId?: unknown } | null)?.captureId
  return typeof id === 'string' && id ? id : null
}
