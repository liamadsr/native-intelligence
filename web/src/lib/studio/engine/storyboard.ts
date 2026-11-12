// The storyboard: one ordered list of beats per project that the person, the assistant and every later step read.
// A beat is a stretch of the timeline (frames) with its words, where its picture comes from (a camera track, the
// screen, a generated shot, a code scene or a product component), notes, a status and an optional lock.
// Beats that still need footage are the placeholders you record into (see record-take.ts).
import { z } from 'zod';

const frame = z.number().int().min(0).max(10_000_000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const cameraSlots = ['A', 'B', 'C', 'D'] as const;
export type CameraSlot = typeof cameraSlots[number];
export const pictureSources = ['screen', 'slides', 'generated', 'scene', 'component', 'broll'] as const;
export const BeatSourceSchema = z.union([z.enum(pictureSources), z.string().regex(/^camera:[A-D]$/) as z.ZodType<`camera:${CameraSlot}`>]);
export type BeatSource = z.infer<typeof BeatSourceSchema>;
export const beatStatuses = ['planned', 'recorded', 'generated', 'placed', 'done'] as const;

export const BeatGenerationSchema = z.object({
  prompt: z.string().max(12_000).optional(), model: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,79}$/).optional(), params: z.record(z.string(), z.unknown()).optional(),
  references: z.array(id).max(16).optional(), stillPrompt: z.string().max(8000).optional(), stillAssetId: id.optional(), clipAssetId: id.optional(),
  estCredits: z.number().min(0).max(100_000).optional(), spentCredits: z.number().min(0).max(100_000).optional(), quality: z.enum(['draft', 'final']).optional(),
  stage: z.enum(['planned', 'still', 'still-approved', 'clip', 'final']).optional(), jobId: z.string().max(120).optional(),
}).strict();
export type BeatGeneration = z.infer<typeof BeatGenerationSchema>;
/** One recording of a beat: which session, where its kept part sits on that take's screen clock (ms), how many tries. */
export const BeatTakeSchema = z.object({ sessionId: z.string().max(120), at: z.string().max(40), screenAssetId: id, attempts: z.number().int().min(1).max(100).optional(),
  startMs: z.number().min(0).max(36_000_000).optional(), endMs: z.number().min(0).max(36_000_000).optional() }).strict();
export const BeatSchema = z.object({
  id, label: z.string().max(80).optional(), words: z.string().max(4000),
  startFrame: frame, durationFrames: frame.min(1),
  source: BeatSourceSchema,
  /** What the picture shows (for the person and for generation prompts). */
  shot: z.string().max(4000).optional(),
  arrive: z.string().max(80).optional(), leave: z.string().max(80).optional(),
  status: z.enum(beatStatuses),
  /** Locked beats are the person's: the assistant can't change, move, split or remove them. */
  locked: z.boolean().optional(),
  /** Layers that only stand in until the footage lands (removed when the beat is recorded). */
  placeholders: z.array(id).max(16).optional(),
  takes: z.array(BeatTakeSchema).max(100).optional(),
  /** The take on the timeline now (its sessionId); the latest one unless the person picked another. */
  activeTake: z.string().max(120).optional(),
  generation: BeatGenerationSchema.optional(),
}).strict();
export type Beat = z.infer<typeof BeatSchema>;
const Device = z.object({ deviceId: z.string().min(1).max(400), name: z.string().min(1).max(200) }).strict();
/** Which real input feeds each track, set once in the track headers and remembered with the project. */
export const TrackInputsSchema = z.object({
  cameras: z.partialRecord(z.enum(cameraSlots), Device).optional(),
  screen: z.object({ bundleId: z.string().max(300).optional(), appName: z.string().min(1).max(200), windowTitle: z.string().max(400).optional() }).strict().optional(),
  microphone: Device.optional(),
  countdown: z.number().int().min(0).max(10).optional(),
  slidesDeckId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type TrackInputs = z.infer<typeof TrackInputsSchema>;
export const StoryboardSchema = z.object({
  beats: z.array(BeatSchema).max(300),
  inputs: TrackInputsSchema.optional(),
  /** Cast and props for generated shots: a person (made only from their own photos, with consent), an object or a place. */
  cast: z.array(z.object({ id, name: z.string().min(1).max(80), kind: z.enum(['person', 'prop', 'location']), assetIds: z.array(id).min(1).max(12),
    notes: z.string().max(2000).optional(), consent: z.boolean().optional() }).strict()).max(40).optional(),
  /** The reference film this storyboard follows, and the blueprint made from it. */
  referenceAssetId: id.optional(), blueprintId: z.string().max(120).optional(),
  /** The film's look (style-packs/<name>); the product's style guide still owns colour and type. */
  stylePack: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
}).strict().superRefine((board, ctx) => {
  const ids = new Set<string>();
  board.beats.forEach((beat, i) => {
    if (ids.has(beat.id)) ctx.addIssue({ code: 'custom', message: `Beat id ${beat.id} is used twice` }); ids.add(beat.id);
    const prev = board.beats[i - 1];
    if (prev && beat.startFrame < prev.startFrame + prev.durationFrames) ctx.addIssue({ code: 'custom', message: `Beats must be in order without overlapping (${prev.id} runs into ${beat.id})` });
  });
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const beatEnd = (beat: Beat) => beat.startFrame + beat.durationFrames;
export const isCamera = (source: BeatSource): source is `camera:${CameraSlot}` => source.startsWith('camera:');
export const cameraSlot = (source: BeatSource) => isCamera(source) ? source.slice(7) as CameraSlot : null;
/** Footage comes from recording: a camera or the screen. A beat with words also needs your voice whatever its picture. */
export const isRecorded = (source: BeatSource) => source === 'screen' || isCamera(source);
export const needsRecording = (beat: Beat) => isRecorded(beat.source) || beat.words.trim().length > 0;
/** A placeholder: a beat still waiting for its take. */
export const isPlaceholder = (beat: Beat) => beat.status === 'planned' && needsRecording(beat);
export const sortBeats = (beats: Beat[]) => [...beats].sort((a, b) => a.startFrame - b.startFrame);
export const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
/** Speaking pace used to budget words to a beat's length (the reference's pace when known). */
export const WORDS_PER_SECOND = 2.6;

/** After cutting stretches out of the timeline: beats move left and shrink; a beat cut away completely is dropped. */
export function cutBeats(board: Storyboard | undefined, mapFrame: (frame: number) => number): Storyboard | undefined {
  if (!board) return board;
  const beats = board.beats.flatMap(beat => { const start = mapFrame(beat.startFrame), end = mapFrame(beatEnd(beat));
    return end > start ? [{ ...beat, startFrame: start, durationFrames: end - start }] : []; });
  return { ...board, beats };
}
/** After inserting `length` frames at `at`: later beats move right, a beat spanning `at` grows. */
export function insertBeats(board: Storyboard | undefined, at: number, length: number): Storyboard | undefined {
  if (!board || !length) return board;
  return { ...board, beats: board.beats.map(beat => beat.startFrame >= at ? { ...beat, startFrame: beat.startFrame + length }
    : beatEnd(beat) > at ? { ...beat, durationFrames: beat.durationFrames + length } : beat) };
}

/** The selected beats as one contiguous stretch to record into. */
export function slotFor(board: Storyboard, ids: string[]) {
  const chosen = sortBeats(board.beats.filter(beat => ids.includes(beat.id)));
  if (!chosen.length || chosen.length !== new Set(ids).size) throw new Error(`Unknown beat: ${ids.filter(i => !board.beats.some(b => b.id === i)).join(', ')}`);
  const all = sortBeats(board.beats), first = all.indexOf(chosen[0]!);
  chosen.forEach((beat, k) => { if (all[first + k] !== beat) throw new Error('Choose beats that follow each other (no gaps between them)'); });
  const locked = chosen.filter(beat => beat.locked && beat.status !== 'planned');
  if (locked.length) throw new Error(`Beat ${locked[0]!.label ?? locked[0]!.id} is locked with its footage; unlock it to record again`);
  return { beats: chosen, from: chosen[0]!.startFrame, to: beatEnd(chosen.at(-1)!) };
}

/** Teleprompter lines for the beats being recorded; beats without words become a short pause cue. */
export function prompterFor(beats: Beat[], fps: number) {
  return beats.map(beat => ({ text: beat.words.trim() || `(pause: ${beat.label ?? beat.source})`, seconds: Math.max(0.5, Math.round(beat.durationFrames / fps * 10) / 10), ...(beat.label ? { label: beat.label } : {}) }));
}

export const newBeatId = (board: Storyboard | undefined) => { const used = new Set(board?.beats.map(b => b.id)); let n = board?.beats.length ?? 0; let next: string; do next = `beat-${++n}`; while (used.has(next)); return next; };

/** Beats from a teleprompter script ([Ns] lengths, Label: lines), laid end to end from startFrame. */
export function beatsFromScript(script: { text: string; seconds?: number; label?: string }[], fps: number, options: { startFrame?: number; source?: BeatSource } = {}): Beat[] {
  let at = options.startFrame ?? 0;
  return script.map((line, i) => { const seconds = line.seconds ?? Math.max(1.5, wordCount(line.text) / WORDS_PER_SECOND + 0.4), durationFrames = Math.max(1, Math.round(seconds * fps));
    const beat: Beat = { id: `beat-${i + 1}`, ...(line.label ? { label: line.label } : {}), words: line.text, startFrame: at, durationFrames, source: options.source ?? 'camera:A', status: 'planned' };
    at += durationFrames; return beat; });
}

/** Words a beat can hold at a speaking pace, and how its words compare. */
export function wordBudget(beat: Beat, fps: number, pace = WORDS_PER_SECOND) {
  const budget = Math.round(beat.durationFrames / fps * pace), words = wordCount(beat.words);
  return { budget, words, over: Math.max(0, words - budget) };
}

/** Re-lay planned beats end to end in the given order starting where the first of them starts; recorded beats can't move. */
export function reorderBeats(board: Storyboard, order: string[]): Storyboard {
  const beats = sortBeats(board.beats); if (order.length !== beats.length || new Set(order).size !== beats.length || order.some(i => !beats.some(b => b.id === i))) throw new Error('Give every beat id once, in the new order');
  let at = beats[0]?.startFrame ?? 0;
  const next = order.map(i => { const beat = beats.find(b => b.id === i)!; const moved = { ...beat, startFrame: at }; at += beat.durationFrames; return moved; });
  const footage = next.find(beat => beat.status !== 'planned' && beat.startFrame !== beats.find(b => b.id === beat.id)!.startFrame);
  if (footage) throw new Error(`${footage.label ?? footage.id} already has footage; move the clips on the timeline instead`);
  return { ...board, beats: next };
}
