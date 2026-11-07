/**
 * Who reads aloud right now. The desktop has ONE tts queue per app, and more
 * than one reader wants it: every ChatPanel's useReadAloud (a reply, auto-read,
 * voice mode's lines) and the section player (./section-player: the play
 * button on a heading in rendered markdown or the note editor).
 *
 * The latest reader wins. `claimReader` ends the previous owner's run through
 * its `lose`, which drops that run WITHOUT cancelling again: the new reader's
 * own leading cancel clears the queue before its first sentence.
 */

let reader: { owner: object; lose: () => void } | null = null

/** Take the desktop queue; another owner holding it loses its run. */
export function claimReader(owner: object, lose: () => void) {
  if (reader && reader.owner !== owner) reader.lose()
  reader = { owner, lose }
}

/** Let go of the queue (a run ended). A no-op unless `owner` holds it. */
export function releaseReader(owner: object) {
  if (reader?.owner === owner) reader = null
}

/** Someone is reading aloud now (a chat reply, a line, a section, a Listen
 *  item). Interactive mode resumes a paused reading only when no one is. */
export function isReaderBusy(): boolean {
  return reader !== null
}
