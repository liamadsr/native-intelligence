import React from 'react';
import { Video as DecodedVideo } from '@remotion/media';
import { Html5Video, useRemotionEnvironment } from 'remotion';

type Props = { src: string; trimBefore?: number; durationInFrames?: number; playbackRate?: number; muted?: boolean; volume?: number;
  style?: React.CSSProperties; maxCanvasSinkFrameSize?: { width: number }; alpha?: boolean };

/** Safari's WebKit — the desktop app's web view (Chromium and the export's headless browser are not this). */
export const webkitPreview = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

/**
 * Footage in the picture. Exports (and Chromium) use @remotion/media: frame-exact WebCodecs decoding. In the desktop
 * app's preview that decoder keeps full-size decoded frames in ordinary memory — ~42 MB each for a 4112×2580 screen
 * recording — so playback grew the web process past 2 GB, stalled and crashed. There the preview uses the Mac's native
 * video player instead (hardware decoded, streamed, synced to the Player's clock by Remotion). Transparent footage
 * (subject cut-outs: VP9 with alpha, which Safari's player cannot show) keeps the decoder.
 */
/** True while the desktop app's preview draws: Safari's WebKit renders SVG filters (our directional motion blur) on
 *  the CPU, so there the preview uses GPU-accelerated CSS blur instead; exports keep the exact SVG streaks. */
export function useCheapEffects() { return useRemotionEnvironment().isPlayer && webkitPreview; }

export function MediaVideo({ alpha, maxCanvasSinkFrameSize, durationInFrames, ...props }: Props) {
  const environment = useRemotionEnvironment(), transparent = alpha ?? /\.webm($|\?)/i.test(props.src);
  if (environment.isPlayer && webkitPreview && !transparent) {
    return <Html5Video src={props.src} trimBefore={props.trimBefore} playbackRate={props.playbackRate} muted={props.muted} volume={props.volume}
      pauseWhenBuffering={false} acceptableTimeShiftInSeconds={0.25} style={{ objectFit: 'fill', ...props.style }} />;
  }
  // Callers give the timeline frames the footage plays for; @remotion/media's durationInFrames counts source frames (at
  // the composition's fps) from trimBefore, so a clip played at 2x needs twice as many, or it goes blank half way.
  const sourceFrames = durationInFrames === undefined ? undefined : Math.ceil(durationInFrames * (props.playbackRate ?? 1) - 1e-9);
  return <DecodedVideo {...props} durationInFrames={sourceFrames} maxCanvasSinkFrameSize={maxCanvasSinkFrameSize} />;
}
