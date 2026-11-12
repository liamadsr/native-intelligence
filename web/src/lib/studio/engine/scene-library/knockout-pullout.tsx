// Knock-out pull-out (a one-word ad, the word ending in a full stop): a colour panel with a word knocked out of it, so the footage
// shows through the letters, and a line of type above it. The view starts deep inside the word's last character (its
// full stop) and pulls out, evenly in log-scale with an ease in and out, until the whole line has landed.
// Everything is a setting: the words, colours, font, where and how big each line sits (px in a 1080×1920 frame), and
// when and how far the zoom travels. The zoom centre is measured from the font, so any word works. When the render
// supplied the word's outlines they cut the hole (they stay sharp at any zoom); an edited word falls back to text,
// which browsers stop drawing beyond about 20× — ask for a re-render after changing the word.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  line?: string; word?: string; panel?: string; ink?: string; font?: string;
  lineX?: number; lineY?: number; lineSize?: number; lineTrack?: number;
  wordX?: number; wordY?: number; wordSize?: number; wordTrack?: number;
  /** Seconds from the layer's start, how long the pull-out takes, and how far in it starts (×). */
  zoomAt?: number; zoomSeconds?: number; from?: number;
  /** The full stop's ink centre (px), as measured for the word, font, size and position named in originFor. */
  origin?: [number, number]; originFor?: string;
  /** The word as outlines (an SVG path in frame px), drawn from the font file for the same word, font, size and
   *  position as originFor. Browsers stop drawing text at the sizes the zoom reaches; a path scales without limit. */
  wordPath?: string; wordPathFor?: string;
};

const easeInOut = (x: number) => x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;

export default function KnockoutPullOut(p: Props) {
  const { line = 'Wellness starts', word = 'within.', panel = '#D0E4D7', ink = '#243428', font = 'Ivy Presto Headline',
    lineX = 66, lineY = 836, lineSize = 146, lineTrack = -3, wordX = 60, wordY = 1124, wordSize = 330, wordTrack = -8,
    zoomAt = 2.55, zoomSeconds = 1.95, from = 72 } = p;
  const frame = useCurrentFrame(), { fps } = useVideoConfig();
  const ref = useRef<SVGTextElement>(null), [mask] = useState(() => `knockout-${Math.random().toString(36).slice(2, 10)}`);
  // The centre measured when the piece was made stays right until the word, font, size or position changes; only then
  // is it measured again here (a render must wait for that, so it holds the frame until the font has loaded).
  const key = [word, font, wordSize, wordX, wordY, wordTrack].join('|'), measured = p.origin && p.originFor === key ? p.origin : null;
  const [origin, setOrigin] = useState<[number, number]>(measured ?? p.origin ?? [wordX + wordSize * 2.5, wordY - wordSize * 0.07]);
  const [handle] = useState(() => measured ? null : delayRender('Measuring the knocked-out word'));
  const released = useRef(false);
  // The ink centre of the last character: its pen position from the SVG layout (kerning and tracking included) plus
  // the ink box the font reports for it. A few px off shows as an arc of panel colour at the start of the zoom.
  useLayoutEffect(() => {
    if (measured) { setOrigin(measured); return; }
    let live = true; const spec = `400 ${wordSize}px "${font}"`;
    document.fonts.load(spec, word).then(() => {
      const el = ref.current; if (!live || !el || el.getNumberOfChars() < 1 || !document.fonts.check(spec, word)) return;
      const pen = el.getStartPositionOfChar(el.getNumberOfChars() - 1), ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      ctx.font = spec;
      const m = ctx.measureText(word.slice(-1));
      setOrigin([pen.x + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, pen.y + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2]);
    }).catch(() => undefined).finally(() => { if (handle !== null && !released.current) { released.current = true; continueRender(handle); } });
    return () => { live = false; };
  }, [key, handle]);
  const x = Math.max(0, Math.min(1, (frame / fps - zoomAt) / Math.max(0.01, zoomSeconds)));
  const scale = Math.pow(Math.max(1, from), 1 - easeInOut(x)), [ox, oy] = origin;
  const zoom = `translate(${ox} ${oy}) scale(${scale}) translate(${-ox} ${-oy})`;
  const type = (size: number, track: number): React.CSSProperties => ({ fontFamily: `"${font}"`, fontSize: size, letterSpacing: track, fontKerning: 'normal' });
  return <svg viewBox="0 0 1080 1920" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}>
    <defs><mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={1080} height={1920}>
      <rect width={1080} height={1920} fill="white" />
      {p.wordPath && p.wordPathFor === key ? <path d={p.wordPath} fill="black" transform={zoom} /> : null}
      <text ref={ref} x={wordX} y={wordY} fill="black" transform={zoom} style={type(wordSize, wordTrack)} opacity={p.wordPath && p.wordPathFor === key ? 0 : 1}>{word}</text>
    </mask></defs>
    <rect width={1080} height={1920} fill={panel} mask={`url(#${mask})`} />
    <text x={lineX} y={lineY} fill={ink} transform={zoom} style={type(lineSize, lineTrack)}>{line}</text>
  </svg>;
}
