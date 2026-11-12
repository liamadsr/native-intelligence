import { EditorProjectSchema, type EditorProject } from './contracts';
import { scheduleProject, splitClip } from './timeline';
import { insertAutomation } from './automation';
import { insertLayers } from './layers';
import { insertBeats } from './storyboard';
import { deleteTimelineRanges } from './transcript';
import { clipView } from './shots';

/**
 * Put a freshly recorded take into an existing edit (Logic-style punch-in): the stretch fromFrame..toFrame is cut out
 * (or nothing, for a pure insert) and the take's sections land there. Picture, voice, camera and slides all come along,
 * each still following its own recording clock.
 */
export function punchIn(target: EditorProject, take: EditorProject, fromFrame: number, toFrame: number): EditorProject {
  let project = toFrame > fromFrame ? deleteTimelineRanges(target, [{ startFrame: fromFrame, endFrame: toFrame }]) : structuredClone(target);
  const total = scheduleProject(project).reduce((end, s) => Math.max(end, s.startFrame + s.durationFrames), 0), at = Math.min(fromFrame, total);
  // Split whatever clip spans the punch point so the take slots in between.
  const spanning = scheduleProject(project).find(s => at > s.startFrame && at < s.startFrame + s.durationFrames);
  if (spanning) project = splitClip(project, spanning.clip.id, at - spanning.startFrame);
  const index = scheduleProject(project).filter(s => s.startFrame + s.durationFrames <= at).length;
  const takeClips = take.clips.map(clip => ({ ...clip, id: `punch-${clip.id}`.slice(0, 120) }));
  const assets = [...project.assets, ...take.assets.filter(asset => !project.assets.some(item => item.id === asset.id))];
  let presenterTrack = project.presenterTrack, clips = [...project.clips.slice(0, index), ...takeClips, ...project.clips.slice(index)];
  const takeCamera = take.presenterTrack?.sync ? take.presenterTrack : null;
  if (takeCamera) {
    if (!presenterTrack) presenterTrack = takeCamera;
    else if (presenterTrack.sync) presenterTrack = { ...presenterTrack, takes: [...(presenterTrack.takes ?? []), { screenAssetId: takeCamera.sync!.screenAssetId, assetId: takeCamera.assetId, offsetSeconds: takeCamera.sync!.offsetSeconds }] };
    else clips = clips.map(clip => takeClips.some(item => item.id === clip.id) ? { ...clip, view: { ...clipView(clip), main: clipView(clip).main === 'camera' ? 'screen' : clipView(clip).main, bubble: false } } : clip);
  }
  let slideDeck = project.slideDeck ?? null;
  if (take.slideDeck) {
    if (!slideDeck) slideDeck = take.slideDeck;
    else if (slideDeck.id === take.slideDeck.id) slideDeck = { ...slideDeck, takes: [...(slideDeck.takes ?? []), { screenAssetId: take.slideDeck.screenAssetId, changes: take.slideDeck.changes }] };
    // A different deck cannot share the slides lane: the take's slide shots fall back to its screen.
    else clips = clips.map(clip => takeClips.some(item => item.id === clip.id) && clipView(clip).main === 'slides' ? { ...clip, view: { ...clipView(clip), main: 'screen' } } : clip);
  }
  // Extra windows/cameras: a source with the same kind and name gets this take as another clip of it; new ones are added.
  let sources = project.sources;
  const rename = new Map<string, string>();
  for (const source of take.sources ?? []) {
    const match = sources?.find(item => item.kind === source.kind && item.name === source.name);
    if (match) { sources = sources!.map(item => item.id === match.id ? { ...item, takes: [...(item.takes ?? []), { screenAssetId: source.sync.screenAssetId, assetId: source.assetId, offsetSeconds: source.sync.offsetSeconds }] } : item); rename.set(source.id, match.id); }
    else { let id = source.id, n = 2; while (sources?.some(item => item.id === id)) id = `${source.id}-${n++}`; sources = [...(sources ?? []), { ...source, id }]; rename.set(source.id, id); }
  }
  if (rename.size) clips = clips.map(clip => takeClips.some(item => item.id === clip.id) && clip.view ? { ...clip, view: { ...clip.view, main: rename.get(clip.view.main) ?? clip.view.main,
    ...(clip.view.layout ? { layout: { ...clip.view.layout, sources: clip.view.layout.sources.map(id => rename.get(id) ?? id) } } : {}) } } : clip);
  // Automation, layers and beats after the punch point move right by the take's length on this edit's clock (the take
  // may run at another frame rate, so measure its clips as they sit in this project, not in the take).
  const placedIds = new Set(takeClips.map(clip => clip.id));
  const length = scheduleProject({ ...project, assets, clips }).filter(s => placedIds.has(s.clip.id)).reduce((n, s) => n + s.durationFrames, 0);
  const automation = insertAutomation(project, at, length);
  const layers = insertLayers(project.layers, at, length);
  const storyboard = insertBeats(project.storyboard, at, length);
  return EditorProjectSchema.parse({ ...project, assets, clips, presenterTrack, slideDeck, automation, ...(layers ? { layers } : {}), ...(storyboard ? { storyboard } : {}), ...(sources?.length ? { sources } : {}), transcripts: [...project.transcripts, ...take.transcripts.filter(t => !project.transcripts.some(item => item.id === t.id))] });
}
