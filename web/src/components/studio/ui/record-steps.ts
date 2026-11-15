/**
 * What a recording is doing, in words for the person who made it.
 *
 * While a take is made into a video, the Studio reports the worker's latest log line as its step ("Conforming the
 * recording to a constant 30 fps (H.264/AAC)", "Storing assets/….mp4 (12.3 MB)"). Those are for the log, not for a
 * person: the known ones are said plainly here, and anything else falls back to "Preparing your recording".
 */

/** The steps the app itself writes, which already read as sentences. */
const PLAIN = new Set(['Uploading', 'Saving the recording', 'Preparing your recording', 'Bringing back your recording', 'Putting your recording together']);

/** Which track a worker line is about, from the file name it mentions. */
const trackOf = (line: string) => /camera/i.test(line) ? 'the camera' : /microphone|voice|system sound|audio|\.m4a|\.weba|\.ogg/i.test(line) ? 'the sound' : /screen/i.test(line) ? 'the screen recording' : 'the video';

export function plainStep(step: string | null | undefined): string {
  const line = (step ?? '').trim();
  if (!line) return 'Preparing your recording';
  if (PLAIN.has(line)) return line;
  if (/^waiting for the studio worker/i.test(line)) return 'Waiting for the Studio to start';
  if (/^(storing|putting|export complete|checking complete)/i.test(line)) return 'Almost done';
  if (/has sound and no picture/i.test(line)) return 'Preparing the sound';
  if (/^(downloading|conforming|the file does not say how long|this file's frame rate)/i.test(line)) return `Preparing ${trackOf(line)}`;
  return 'Preparing your recording';
}
