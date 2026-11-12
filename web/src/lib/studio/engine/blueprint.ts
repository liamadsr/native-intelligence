// A blueprint is what a reference film teaches about structure: where it cuts, how long each beat runs, how fast
// the person talks, how busy the picture is. Built from the review (scenes, motion, on-screen text) and the film's
// own speech (local transcription), saved with the reference so any project can start its storyboard from it.
import { wordCount, type BeatSource } from './storyboard';

export type ReviewScene = { index: number; start: number; end: number; seconds: number; alive?: number; luma?: number; layers?: unknown[]; said?: string };
export type ReviewResult = { seconds: number; scenes: ReviewScene[]; profile: Record<string, unknown>; motion?: { summary?: Record<string, unknown> } };
export type TimedWord = { text: string; startMs: number; endMs: number; /** The transcriber ended a phrase here. */ end?: boolean };
export type BlueprintBeat = { start: number; end: number; seconds: number; scene: number; kind: 'talk' | 'visual'; said: string; words: number; wordsPerSecond: number };
export type Blueprint = { schemaVersion: 1; assetId: string; seconds: number; createdAt: string;
  pace: number; speechShare: number; beats: BlueprintBeat[]; scenes: { start: number; end: number }[];
  style: { medianScene: number; cutsPerMinute: number; alive?: number; movesPerSecond?: number; snapShare?: number; overshootShare?: number; textHeight?: number; wordsOnScreen?: number; luma?: number; palette?: string[] } };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Sentences from timed words: a sentence ends at . ! ? or at a pause longer than 0.6 s. */
export function sentences(words: TimedWord[]) {
  const out: { start: number; end: number; text: string; words: number }[] = []; let current: TimedWord[] = [];
  const flush = () => { if (current.length) out.push({ start: current[0]!.startMs / 1000, end: current.at(-1)!.endMs / 1000, text: current.map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'), words: current.length }); current = []; };
  words.forEach((word, i) => { current.push(word); const next = words[i + 1];
    if (word.end || /[.!?…]["”')\]]*$/.test(word.text) || (next && next.startMs - word.endMs > 600) || (current.length >= 24 && /[,;:]$/.test(word.text)) || current.length >= 32) flush(); });
  flush(); return out;
}

/** The beat grid: scene cuts are hard boundaries; inside a scene, sentences group into beats of about 3–9 s;
 *  stretches of 1.5 s or more without speech become visual beats. */
export function makeBlueprint(assetId: string, review: ReviewResult, words: TimedWord[], options: { minBeat?: number; maxBeat?: number } = {}): Blueprint {
  const min = options.minBeat ?? 3, max = options.maxBeat ?? 9, all = sentences(words);
  const beats: BlueprintBeat[] = [];
  const push = (start: number, end: number, scene: number, said: string[]) => { const text = said.join(' '), n = wordCount(text), seconds = round(end - start);
    if (seconds <= 0.05) return; beats.push({ start: round(start), end: round(end), seconds, scene, kind: n ? 'talk' : 'visual', said: text, words: n, wordsPerSecond: n ? round(n / seconds) : 0 }); };
  for (const scene of review.scenes) {
    const inside = all.filter(s => s.start >= scene.start - 0.05 && s.start < scene.end);
    let cursor = scene.start, group: typeof inside = [];
    const close = (end: number) => { if (!group.length) return; push(cursor, end, scene.index, group.map(s => s.text)); cursor = end; group = []; };
    for (const sentence of inside) {
      if (!group.length && sentence.start - cursor >= 1.5) push(cursor, sentence.start, scene.index, []), cursor = sentence.start;
      const span = sentence.end - cursor;
      if (group.length && span > max && (group.at(-1)!.end - cursor) >= min) close(sentence.start);
      group.push(sentence);
    }
    const lastEnd = group.at(-1)?.end ?? cursor;
    if (group.length) { if (scene.end - lastEnd >= 1.5) { close(lastEnd); push(cursor, scene.end, scene.index, []); } else close(scene.end); }
    else push(cursor, scene.end, scene.index, []);
  }
  const spoken = beats.filter(b => b.kind === 'talk'), talkSeconds = spoken.reduce((n, b) => n + b.seconds, 0), talkWords = spoken.reduce((n, b) => n + b.words, 0);
  const p = review.profile, m = review.motion?.summary ?? {};
  return { schemaVersion: 1, assetId, seconds: round(review.seconds), createdAt: new Date().toISOString(),
    pace: talkSeconds ? round(talkWords / talkSeconds) : 0, speechShare: round(talkSeconds / Math.max(0.01, review.seconds)), beats,
    scenes: review.scenes.map(s => ({ start: round(s.start), end: round(s.end) })),
    style: { medianScene: num(p.median_scene_s) ?? 0, cutsPerMinute: num(p.scenes_per_min) ?? 0, alive: num(p.alive), movesPerSecond: num(p.moves_per_s), snapShare: num(m.snap_share), overshootShare: num(m.overshoot_share),
      textHeight: num(p.text_height_median), wordsOnScreen: num(p.words_on_screen_median), luma: num(p.luma),
      palette: Array.isArray(p.palette) ? (p.palette as { hex?: unknown }[]).map(c => c?.hex).filter((h): h is string => typeof h === 'string' && /^#[\da-fA-F]{3,8}$/.test(h)) : undefined } };
}

/** Storyboard lines that follow a blueprint's rhythm, scaled to a target length. Words are left for the script
 *  writer (each line says how many words its length holds at the reference's pace). */
export function linesFromBlueprint(blueprint: Blueprint, options: { seconds?: number; talkSource?: BeatSource; visualSource?: BeatSource } = {}) {
  const scale = options.seconds ? options.seconds / blueprint.seconds : 1, pace = blueprint.pace || 2.6;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return blueprint.beats.map((beat, i) => { const seconds = Math.max(0.5, round(beat.seconds * scale, 1));
    return { label: `${beat.kind === 'talk' ? 'Talk' : 'Visual'} ${i + 1}`, text: '', seconds, source: beat.kind === 'talk' ? (options.talkSource ?? 'camera:A') : (options.visualSource ?? 'scene'),
      shot: `Reference ${mmss(beat.start)}–${mmss(beat.end)} (scene ${beat.scene + 1})${beat.kind === 'talk' ? `: ${beat.words} words at ${beat.wordsPerSecond}/s; about ${Math.round(seconds * pace)} words fit here. They said: “${beat.said.slice(0, 220)}${beat.said.length > 220 ? '…' : ''}”` : ': no speech, picture carries it'}` }; });
}
