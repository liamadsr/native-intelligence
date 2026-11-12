import { useSyncExternalStore } from 'react';
import { request } from './client';

/**
 * The playhead during playback, outside React state: the Player reports a frame 30–60 times a second, and putting
 * that into App state re-rendered the whole editor (timeline, lanes, inspector, transcript) on every frame — fine in
 * Chromium, a stall in Safari's WebKit (the desktop app). Only the playhead line and the timecode follow it live; the
 * rest of the editor catches up a few times a second and exactly on pause.
 */
let current = 0;
const listeners = new Set<() => void>();
export const liveFrame = {
  get: () => current,
  set(frame: number) { if (frame === current) return; current = frame; for (const listener of listeners) listener(); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export const useLiveFrame = () => useSyncExternalStore(liveFrame.subscribe, liveFrame.get, liveFrame.get);

/** Playback measurements, reported to the editor server (/api/account/studio/perf) while playing: frame pacing and how long each
 *  editor update takes. Switches (/api/account/studio/perf-config) let a fix be compared with the old behaviour without a rebuild. */
export const perf = { throttle: true, renderStart: 0, playing: false, commits: [] as number[], frames: [] as number[], last: 0, since: 0, advanced: 0, waits: 0, firstFrame: -1, lastFrame: -1, label: '', hitches: [] as [number, number][] };
/** The Player moved to a frame (playback progress) / stalled waiting for media. */
export function noteFrame(frame: number) { if (!perf.playing) return; perf.advanced++; if (perf.firstFrame < 0) perf.firstFrame = frame; perf.lastFrame = frame; }
export function noteWaiting() { if (perf.playing) perf.waits++; }
const readConfig = () => fetch('/api/account/studio/perf-config').then(r => r.ok ? r.json() : null).then((c: { throttle?: boolean } | null) => { if (c && typeof c.throttle === 'boolean') perf.throttle = c.throttle; }).catch(() => {});
void readConfig();
export function markRender() { perf.renderStart = performance.now(); }
export function markCommit() { if (perf.playing) perf.commits.push(performance.now() - perf.renderStart); }
function loop(t: number) {
  if (!perf.playing) return;
  if (perf.last) { const gap = t - perf.last; perf.frames.push(gap); if (gap > 70) perf.hitches.push([Math.round(gap), current]); } perf.last = t;
  if (t - perf.since > 3000 && perf.frames.length > 10) report();
  requestAnimationFrame(loop);
}
function stats(values: number[]) { const v = [...values].sort((a, b) => a - b), n = v.length; return n ? { n, median: +v[n >> 1]!.toFixed(1), p95: +v[Math.floor(n * 0.95)]!.toFixed(1), max: +v[n - 1]!.toFixed(1), total: Math.round(v.reduce((a, b) => a + b, 0)) } : { n: 0 }; }
function report() {
  const seconds = (performance.now() - perf.since) / 1000;
  const body = { at: new Date().toISOString(), throttle: perf.throttle, label: perf.label, seconds: +seconds.toFixed(2), playheadAdvancedFrames: perf.lastFrame - perf.firstFrame, hitches: perf.hitches.slice(0, 12), frameUpdates: perf.advanced, waits: perf.waits, ua: navigator.userAgent.slice(0, 120), window: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, frames: stats(perf.frames), commits: stats(perf.commits), dom: document.getElementsByTagName('*').length };
  perf.frames = []; perf.commits = []; perf.since = performance.now(); perf.hitches = []; perf.advanced = 0; perf.waits = 0; perf.firstFrame = -1; perf.lastFrame = -1;
  void request('/api/account/studio/perf', body).catch(() => {});
}
export function setPlaying(playing: boolean) {
  if (playing === perf.playing) return; perf.playing = playing;
  if (playing) { void readConfig(); perf.advanced = 0; perf.waits = 0; perf.firstFrame = -1; perf.lastFrame = -1; perf.frames = []; perf.commits = []; perf.last = 0; perf.since = performance.now(); requestAnimationFrame(loop); } else if (perf.frames.length > 10) report();
}
