import type { EditorProject } from './contracts';
import { scheduleProject } from './timeline';
import { clipView, shotSegments, sourceLabel } from './shots';
import { paramInfo } from './automation';
import { transcriptWords } from './transcript';

const seconds = (frames: number, fps: number) => Math.round(frames / fps * 100) / 100;

/** What an editing agent needs to see about a project, in seconds and fractions — compact enough to read in one go. */
export function projectSummary(project: EditorProject, maxWords = 400) {
  const fps = project.output.fps, schedule = scheduleProject(project);
  // Word times are on the edited timeline (after cuts), the same clock every command uses.
  const words = transcriptWords(project).filter(w => w.timingReliable).map(w => `${(w.startFrame / fps).toFixed(2)} ${w.text}`);
  const duration = schedule.reduce((n, s) => Math.max(n, s.startFrame + s.durationFrames), 0);
  return {
    id: project.id, title: project.title, output: project.output, durationSeconds: seconds(duration, fps),
    assets: project.assets.map(a => ({ id: a.id, name: a.name, kind: a.kind, width: a.width, height: a.height, seconds: a.durationSeconds })),
    clips: schedule.map(s => ({ id: s.clip.id, asset: s.asset.name, startSeconds: seconds(s.startFrame, fps), endSeconds: seconds(s.startFrame + s.durationFrames, fps),
      shot: clipView(s.clip), playbackRate: s.clip.playbackRate,
      // Clicks in this clip, at timeline seconds, with where they happened on the screen (0–1) — good zoom targets.
      clicks: (s.asset.trace?.actions ?? []).flatMap(action => { if (action.kind !== 'click' || !s.asset.sourceFps || !s.asset.trace) return [];
        const sourceFrame = action.t / 1000 * s.asset.sourceFps; if (sourceFrame < s.clip.trimStartSourceFrame || sourceFrame >= s.clip.trimEndSourceFrame) return [];
        const trace = s.asset.trace, at = s.startFrame + (sourceFrame - s.clip.trimStartSourceFrame) / s.asset.sourceFps * fps / s.clip.playbackRate;
        // Where: the clicked element's centre, else the cursor at that moment.
        const cursor = trace.cursor.reduce<[number, number, number] | null>((best, sample) => sample[0] <= action.t ? sample : best, null);
        const px = action.box ? action.box.x + action.box.w / 2 : cursor?.[1], py = action.box ? action.box.y + action.box.h / 2 : cursor?.[2];
        return [{ time: seconds(at, fps), label: action.label, ...(px !== undefined && py !== undefined ? { x: +(px / trace.viewport.width).toFixed(3), y: +(py / trace.viewport.height).toFixed(3) } : {}) }]; }).slice(0, 60) })),
    layers: (project.layers ?? []).map(layer => ({ id: layer.id, kind: layer.kind, name: layer.name, ...(layer.behind ? { behind: true } : {}), start: seconds(layer.startFrame, fps), end: seconds(layer.endFrame, fps),
      x: layer.x, y: layer.y, width: layer.width, height: layer.height, ...(layer.style.text ? { text: layer.style.text } : {}), enter: layer.enter.preset, exit: layer.exit.preset,
      automation: layer.automation.map(lane => ({ param: lane.param, points: lane.points.map(p => [seconds(p.frame, fps), +p.value.toFixed(3)]) })) })),
    automation: (project.automation?.lanes ?? []).map(lane => ({ param: lane.param, label: paramInfo(lane.param).label, points: lane.points.map(p => [seconds(p.frame, fps), +p.value.toFixed(3)]) })),
    presenter: project.presenterTrack ? { synced: !!project.presenterTrack.sync, rect: project.presenterTrack.segments[0]?.visual.rect } : null,
    /** The Layout track: what is on screen when. */
    shots: shotSegments(project).map(segment => ({ start: seconds(segment.from, fps), end: seconds(segment.to, fps), main: segment.view.main, bubble: segment.view.bubble, ...(segment.view.layout ? { layout: segment.view.layout } : {}) })),
    /** Every picture a shot can show: screen, slides, camera, and extra recorded windows/cameras (src-…). */
    sources: [{ id: 'screen', name: 'Screen (main window)' }, ...(project.slideDeck ? [{ id: 'slides', name: 'Slides' }] : []), ...(project.presenterTrack ? [{ id: 'camera', name: 'Camera' }] : []),
      ...(project.sources ?? []).map(source => ({ id: source.id, name: source.name, kind: source.kind }))].map(item => ({ ...item, label: sourceLabel(project, item.id) })),
    /** Subject cut-outs: recordings whose person/subject is isolated, so layers with behind: true sit behind them. */
    cutouts: (project.cutouts ?? []).map(cut => ({ recording: project.assets.find(a => a.id === cut.assetId)?.name ?? cut.assetId, mode: cut.mode })),
    slides: project.slideDeck ? { name: project.slideDeck.name, pages: project.slideDeck.pageAssetIds.length } : null,
    presentation: { background: project.presentation.background.kind, padding: project.presentation.padding, radius: project.presentation.radius },
    captions: project.captions.enabled,
    transcript: words.length ? (words.length > maxWords ? [...words.slice(0, maxWords), `… ${words.length - maxWords} more words`] : words) : null,
  };
}
