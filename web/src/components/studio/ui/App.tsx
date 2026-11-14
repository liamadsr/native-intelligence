import { studioKeys, studioCan, setStudioCapabilities, previewCodeScenes } from '../studio-env';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormatPicker, SafeZones } from './FormatPicker';
import { deliveredProject, formatPreset } from '@/lib/studio/engine/formats';
import { previewProject } from '@/lib/studio/engine/preview-scale';
import { liveFrame, markCommit, markRender, noteFrame as perfFrame, noteWaiting as perfWaiting, perf, setPlaying as perfPlaying, useLiveFrame } from './live-frame';
import { Player, type PlayerRef } from '@remotion/player';
import { EditorComposition } from '@/lib/studio/engine/composition';
import { familyOf, type FontFace } from '@/lib/studio/engine/font-faces';
import { EditorProjectSchema, parseEditorProject, defaultPresentation, neutralMotion, type EditorAsset, type EditorClip, type EditorPreset, type EditorProject, type EditorZoom, type MotionTrack } from '@/lib/studio/engine/contracts';
import { normalizeProjectZooms, trimClip, projectDuration, scheduleProject, splitClip } from '@/lib/studio/engine/timeline';
import { setShotRange } from '@/lib/studio/engine/shots';
import type { AppProfileSummary, EditorJob } from '@/lib/studio/engine/api';
import { bootstrap, importFile, request, saveProject } from './client';
import { toast } from 'sonner';
import { Icon } from './icons';
import { IconButton, Modal, StudioSelect } from './controls';
import { Inspector, type InspectorTab } from './Inspector';
import { pressRailTab, railTabActive, railTabs, rememberInspectorOpen, rememberedInspectorOpen, showInspectorTab, sidePanelToClose, type SidePanel } from './inspector-panel';
import { Timeline, secondsLabel } from './Timeline';
import { PreviewMotionControls } from './PreviewMotionControls';
import { motionControlOwnsKey, newPlaybackSession, progressPlayback, seekPlayback, spacePlaybackAllowed, startPlayback } from './timeline-input';
import { addZoomBump } from '@/lib/studio/engine/automation';
import { cleanupWords, deleteTimelineRanges, transcriptWords, wordCutRanges } from '@/lib/studio/engine/transcript';
import { ProjectChooser } from './ProjectChooser';
import { CastPage, filmPages, initialPage, OverviewPage, rememberPage, StoryboardPage, type FilmPage } from './FilmPages';
import { NewProjectPanel } from './NewProject';
import { AppsPanel, type AppProfileEditor } from './AppsPanel';
import { cutSelectedWords,selectTimedWord,type WordSelection } from './word-selection';
import { projectFromRecording } from './project-from-recording';
import { useTranscription } from './useTranscription';
import { transcriptionTarget } from './transcription-target';
import { droppedMedia, fileTransfer, type ImportKind } from './media-drop';
import { BROWSER_DRAG, BrowserPanel, browserImport, type BrowserItem } from './BrowserPanel';
import { AppRail } from './AppRail';
import { CampaignPage } from './CampaignPage';
import { editMotionLayerSpan } from '@/lib/studio/engine/motion-authoring';
import { applyTypingSpeed,applyAllTypingSpeeds,resetTypingSpeed,dismissTypingSuggestion } from '@/lib/studio/engine/speed';
import { parseRecoveryDraft,recoveryMatchesSaved,recoveryCopy,serializeRecoveryDraft } from './recovery';
import { createPresenterTrack } from '@/lib/studio/engine/presenter';
import { usePresenterRecorder } from './usePresenterRecorder';
import { PreviewPresenterControls } from './PreviewPresenterControls';
import { LayerInspector } from './LayerInspector';
import { liveItems, removeItems, type TimelineItem } from '@/lib/studio/engine/timeline-selection';
import { applyOps } from '@/lib/studio/engine/ops';
import { BeatInspector } from './Storyboard';
import { PreviewLayoutControls } from './PreviewLayoutControls';
import { PreviewLayerControls } from './PreviewLayerControls';
import { RecordDialog, type PunchTarget } from './RecordDialog';
import { plainStep } from './record-steps';
import { ExportDialog, exportFor, type ExportChoice, type ExportReceipt } from './ExportDialog';
import { continueOnComputer, destinationOf, finishOnServer, finishedWords, startOnComputer, whenSavedHere } from './local-export';
import { studioLocalExport, studioRefusal } from '@/lib/tauri-bridge';
import { isDesktopApp } from '@/lib/platform';
import { arrivalNotice, useExportArrival } from './export-arrival';
import { exportFileName, saveExport } from './save-export';
import { prompterFor, slotFor } from '@/lib/studio/engine/storyboard';
import { askAgentInChat, editorChatNote, type EditorChatLink } from './chat-note';
import { CostChip } from './CostChip';
import { preferredPresenterStyle } from './PresenterPanel';
import { presenterRadius } from '@/lib/studio/engine/presenter';
import { useManualRecording, type RecordingSession, type RecordingStart } from './useManualRecording';
import { canAutoOpenManual, manualContextUnchanged, manualOriginMatches, type ManualOpenIntent } from './manual-open';

type History = { past: EditorProject[]; current: EditorProject; future: EditorProject[]; group?: number|null };
type Dialog = 'projects'|'presets'|'record'|'export'|'navigate'|'new-project'|null;
type RecoveryOffer = { draft: EditorProject; savedAt?: number; same: boolean; base: { digest: string; signature: string } | null; otherProject: boolean };
const conflictPattern = /changed somewhere else/;
const draftTime = (at?: number) => { if (!at) return 'your last session'; const d = new Date(at), today = new Date().toDateString() === d.toDateString(); return today ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const draftKey = 'ni:studio:editor-draft-v1';
const id = () => crypto.randomUUID();
const errorText = (error:unknown) => error instanceof Error ? error.message : String(error);
const clockLabel=(ms:number)=>{const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,"0")}`;};

/** `openVideoId`: the video to open on (a link to one video, the agent showing one); `openPage`: which of its pages. */
/** `onPlace`: told which video is open and on which page, whenever that changes (the page keeps it, so the Studio opens there again and the agent knows what the person is looking at). */
/** `openAsk`: which request `openVideoId`/`openPage` are (a new number asks again). */
/** `onLive`: handed what the app's agent is told when the person messages it with the Studio in front (chat-note.ts), and null as the editor goes. */
export function App({ openVideoId = null, openPage, openAsk, onPlace, onLive }: { openVideoId?: string | null; openPage?: FilmPage; openAsk?: number; onPlace?: (place: { videoId: string | null; title: string | null; page: FilmPage }) => void; onLive?: (link: EditorChatLink | null) => void } = {}) {
  const [notSetUp,setNotSetUp]=useState(false);
  markRender(); useLayoutEffect(() => { markCommit(); });
  const [history,setHistory]=useState<History|null>(null), project=history?.current;
  /** A new video's description, sent to the agent in the app's chat once that video is open. */
  const [agentBrief,setAgentBrief]=useState<{projectId:string;text:string}|null>(null);
  const [projects,setProjects]=useState<{id:string;title:string}[]>([]), [presets,setPresets]=useState<EditorPreset[]>([]);
  const [saved,setSaved]=useState(''),savedRef=useRef(''), projectDigest=useRef<string|null|undefined>(undefined), saveInFlight=useRef<Promise<boolean>|null>(null), failedSaveSignature=useRef(''), [saveError,setSaveError]=useState<string|null>(null), [savingProject,setSavingProject]=useState(false), [chooserOpen,setChooserOpen]=useState(false), [busy,setBusy]=useState<string|null>('Opening video');
  const [dialog,setDialog]=useState<Dialog>(null), [pendingProject,setPendingProject]=useState<string|null>(null),[pendingRecording,setPendingRecording]=useState<EditorProject|null>(null);
  /** Unsaved edits kept in this browser from an earlier session, offered in a slim banner (never a blocking dialog). */
  const [recoveryOffer,setRecoveryOffer]=useState<RecoveryOffer|null>(null);
  /** The agent saved this video while it had unsaved edits here: load its version or keep these. */
  const [agentUpdate,setAgentUpdate]=useState<string|null>(null);
  const [manualIntent,setManualIntent]=useState<ManualOpenIntent|null>(null),[manualFollowUp,setManualFollowUp]=useState<RecordingSession|null>(null),claimedManualSessions=useRef(new Set<string>()),manualOpenLock=useRef(false);
  const [showAppSettings,setShowAppSettings]=useState(false),pendingNavigation=useRef<(()=>Promise<void>|void)|null>(null),[appProfiles,setAppProfiles]=useState<AppProfileSummary[]>([]);
  const [profileDirty,setProfileDirty]=useState(false),profileEditor=useRef<AppProfileEditor|null>(null);
  const registerProfileEditor=useCallback((editor:AppProfileEditor|null)=>{profileEditor.current=editor;},[]);
  const [wordSelection,setWordSelection]=useState<WordSelection>({ids:[],anchor:null});
  const [browserOpen,setBrowserOpen]=useState<boolean>(()=>{try{return localStorage.getItem('ni:studio:browser.open')==='true';}catch{return false;}});
  useEffect(()=>{try{localStorage.setItem('ni:studio:browser.open',String(browserOpen));}catch{/* private mode */}},[browserOpen]);
  useEffect(()=>{const toggle=(e:KeyboardEvent)=>{if(e.metaKey&&e.altKey&&e.code==='KeyB'){e.preventDefault();setBrowserOpen(v=>!v);}};studioKeys.addEventListener('keydown',toggle);return()=>studioKeys.removeEventListener('keydown',toggle);},[]);
  /** The inspector on the right opens and closes like the Browser: remembered on this computer, closed until the person opens it (inspector-panel.ts). */
  const [inspectorOpen,setInspectorOpen]=useState<boolean>(()=>rememberedInspectorOpen(typeof localStorage==='undefined'?null:localStorage));
  useEffect(()=>{rememberInspectorOpen(typeof localStorage==='undefined'?null:localStorage,inspectorOpen);},[inspectorOpen]);
  useEffect(()=>{const toggle=(e:KeyboardEvent)=>{if(e.metaKey&&e.altKey&&e.code==='Digit0'){e.preventDefault();setInspectorOpen(v=>!v);}};studioKeys.addEventListener('keydown',toggle);return()=>studioKeys.removeEventListener('keydown',toggle);},[]);
  /** The Browser and the inspector side by side, when the editor has room for both and a usable preview; when it does not, the one opened earlier closes. */
  const workspaceRef=useRef<HTMLDivElement>(null),sidePanels=useRef<{browser:boolean;inspector:boolean;last:SidePanel|null}>({browser:false,inspector:false,last:null}),hasProject=!!project;
  useLayoutEffect(()=>{const s=sidePanels.current;if(browserOpen&&!s.browser)s.last='browser';if(inspectorOpen&&!s.inspector)s.last='inspector';s.browser=browserOpen;s.inspector=inspectorOpen;
    const node=workspaceRef.current;if(!node)return;const fit=()=>{const now=sidePanels.current,close=sidePanelToClose({browser:now.browser,inspector:now.inspector},node.scrollWidth>node.clientWidth+1,now.last);if(close==='browser')setBrowserOpen(false);else if(close==='inspector')setInspectorOpen(false);};
    fit();const observer=new ResizeObserver(fit);observer.observe(node);return()=>observer.disconnect();},[browserOpen,inspectorOpen,hasProject]);
  const [selectedIds,setSelectedIds]=useState<string[]>([]), [selectedZoom,setSelectedZoom]=useState<string|null>(null), [selectedMotionLayerId,setSelectedMotionLayerId]=useState('primary'), [selectedMotionTrackId,setSelectedMotionTrackId]=useState<string|null>(null), [tab,setTab]=useState<InspectorTab>('background');
  const [importedSource,setImportedSource]=useState<{assetId:string;token:string}|null>(null);
  const [frame,setFrame]=useState(0), [playing,setPlaying]=useState(false), [focusMode,setFocusMode]=useState(false), [job,setJob]=useState<EditorJob|null>(null);
  const [presetName,setPresetName]=useState(''), [exportSize,setExportSize]=useState('native');
  const [exportReceipt,setExportReceipt]=useState<ExportReceipt|null>(null),exportReceiptRef=useRef<ExportReceipt|null>(null);exportReceiptRef.current=exportReceipt;
  const [fileDrag,setFileDrag]=useState(false),fileDragDepth=useRef(0),fileImportLock=useRef(false),recordingLock=useRef(false),[retainedPresenterAssets,setRetainedPresenterAssets]=useState<EditorAsset[]>([]);
  const [previewBox,setPreviewBox]=useState({width:900,height:600});
  const [timelineHeight,setTimelineHeight]=useState(()=>typeof window!=='undefined'&&window.innerHeight<=760?220:330);
  const timelineResize=useRef<{startY:number;height:number}|null>(null);
  const lastFrameCommit=useRef(0);
  const player=useRef<PlayerRef>(null), playbackSession=useRef(newPlaybackSession()), stage=useRef<HTMLDivElement>(null), fileInput=useRef<HTMLInputElement>(null), importKind=useRef<'video'|'image'|'audio'>('video');
  const navigationSeq=useRef(0),projectOpenSeq=useRef(0);
  const manualUiRef=useRef({dialog:null as Dialog,appSettingsOpen:false,presenterRecording:false});
  const pageRef=useRef<FilmPage>('edit');
  const historyRef=useRef(history), gestureHistory=useRef<History|null>(null); historyRef.current=history;
  const currentRef=useRef(project), busyRef=useRef(busy), noticeId=useRef<string|number|null>(null), undoRef=useRef<()=>void>(()=>{}), groupCounter=useRef(0), activeGroup=useRef<number|null>(null);
  currentRef.current=project; busyRef.current=busy;savedRef.current=saved;
  const serialized=useMemo(()=>project?JSON.stringify(project):'', [project]), dirty=!!project&&serialized!==saved;
  const duration=project?projectDuration(project):1;
  const words=useMemo(()=>project?transcriptWords(project):[],[project]);
  const schedule=useMemo(()=>project?scheduleProject(project):[],[project]);
  // The preview draws the edit at preview resolution (preview-scale.ts); exports use the real project.
  const shownProject=useMemo(()=>project?previewProject(project):null,[project]);
  // The preview's shape is the chosen platform format (a reframed view of the edit, drawn by the composition itself).
  const deliveredOutput=useMemo(()=>shownProject?deliveredProject(shownProject).output:null,[shownProject]);
  const [safeZones,setSafeZones]=useState(false);
  // Fonts the film uses: listed by the server (it downloads new ones in the background), handed to the player.
  const [fontFaces,setFontFaces]=useState<FontFace[]>([]);
  const familiesKey=useMemo(()=>[...new Set((shownProject?.layers??[]).map(l=>familyOf(l.style.font)))].sort().join('|'),[shownProject]);
  useEffect(()=>{let alive=true,tries=0;const want=familiesKey?familiesKey.split('|'):[];
    const load=()=>{void request<{faces:FontFace[]}>(`/api/account/studio/fonts?families=${encodeURIComponent(familiesKey)}`).then(r=>{if(!alive)return;setFontFaces(r.faces);const have=new Set(r.faces.map(f=>f.family.toLowerCase()));
      if(want.some(f=>!have.has(f.toLowerCase()))&&++tries<10)setTimeout(load,2500);}).catch(()=>{});};
    load();return()=>{alive=false;};},[familiesKey]);
  // Code scenes run in their locked frame only where the server runs them; otherwise each draws as a labelled box (studio-env.ts).
  const codeScenes=previewCodeScenes();
  const playerInputProps=useMemo(()=>({project:shownProject!,fonts:fontFaces,codeScenes}),[shownProject,fontFaces,codeScenes]);
  const clip=selectedIds.length===1?project?.clips.find(c=>c.id===selectedIds[0]):undefined;
  const zoom=clip?.zooms.find(z=>z.id===selectedZoom);
  // The app's notifications (sonner, mounted by the dashboard shell above every dialog): one Studio notice at a time, as its own toast was.
  // Errors stay longer; a notice about a change Undo can take back carries the app's Undo action.
  const say=useCallback((text:string,error=false,offer?:{undo?:boolean;open?:()=>void})=>{if(noticeId.current!==null)toast.dismiss(noticeId.current);noticeId.current=error?toast.error(text,{duration:15000}):offer?.undo?toast(text,{action:{label:'Undo',onClick:()=>undoRef.current()}}):offer?.open?toast(text,{action:{label:'Open',onClick:offer.open},duration:15000}):toast(text);},[]);
  const manual=useManualRecording(say);
  // While a take records, the editor is locked like during a presenter take; a take going into this edit keeps it locked until it lands.
  const manualLocked=!!manual.active&&(manual.active.status!=='finalizing'||!!manual.active.punch);
  useEffect(()=>{if(!manualLocked)return;recordingLock.current=true;return()=>{recordingLock.current=false;};},[manualLocked]);
  const refreshAppProfiles=useCallback(async()=>{try{setAppProfiles((await request<{profiles:AppProfileSummary[]}>('/api/account/studio/app-profiles')).profiles);}catch(error){say(errorText(error),true);}},[say]);
  useEffect(()=>{void refreshAppProfiles();},[refreshAppProfiles]);
  const change=useCallback((fn:(p:EditorProject)=>EditorProject)=>{
    const group=activeGroup.current; if(recordingLock.current)return; setHistory(h=>{if(!h) return h; let next:EditorProject; try{const raw=fn(h.current);if(raw===h.current)return h;next=normalizeProjectZooms(raw);}catch(error){say(errorText(error),true);return h;} const result=EditorProjectSchema.safeParse(next); if(!result.success) {say(result.error.issues[0]?.message??'This edit is outside the supported range.',true); return h;} if(next===h.current) return h; return {past:group!==null&&h.group===group?h.past:[...h.past,h.current].slice(-80),current:next,future:[],group};});
  },[say]);
  // Device choices (cameras, screen, mic) aren't edits: undo and redo keep today's, whatever the earlier state had.
  const keepInputs=(from:EditorProject,to:EditorProject):EditorProject=>from.storyboard?.inputs&&to.storyboard?{...to,storyboard:{...to.storyboard,inputs:from.storyboard.inputs}}:to;
  const undo=useCallback(()=>{if(recordingLock.current)return;setHistory(h=>gestureHistory.current||!h?.past.length?h:{past:h.past.slice(0,-1),current:keepInputs(h.current,h.past.at(-1)!),future:[h.current,...h.future].slice(0,80)});},[]);
  undoRef.current=undo;
  const redo=useCallback(()=>{if(recordingLock.current)return;setHistory(h=>gestureHistory.current||!h?.future.length?h:{past:[...h.past,h.current].slice(-80),current:keepInputs(h.current,h.future[0]!),future:h.future.slice(1)});},[]);
  const seek=useCallback((n:number,deliberate=true)=>{if(recordingLock.current)return;const p=currentRef.current; if(!p)return; const next=seekPlayback(playbackSession.current,n,projectDuration(p),deliberate);playbackSession.current=next;player.current?.seekTo(next.frame);setFrame(next.frame);},[]);
  const pause=useCallback(()=>{player.current?.pause();setPlaying(false);},[]);
  const openAppSettings=()=>navigate(()=>{pause();setFileDrag(false);setShowAppSettings(true);});
  /** Open one of the project's ads in the editor (from the project overview). */
  const openAd=(adId:string)=>{if(adId===currentRef.current?.id){setPage('edit');return;}rememberPage(adId,'edit');navigate(async()=>{await openProject(adId);});};
  /** Leave Apps setup (from the rail or Back to project), then do `then`. Only unsaved app-profile edits ask first. */
  const leaveSettings=(then?:()=>void)=>{if(!showAppSettings){then?.();return;}if(profileEditor.current?.dirty()){navigate(()=>{setShowAppSettings(false);then?.();});return;}setShowAppSettings(false);then?.();};
  const beginTimelineEdit=useCallback(()=>{pause();gestureHistory.current=historyRef.current;activeGroup.current=++groupCounter.current;},[pause]);
  const endTimelineEdit=useCallback((cancel:boolean)=>{if(cancel&&gestureHistory.current&&historyRef.current?.current.id===gestureHistory.current.current.id){setHistory(gestureHistory.current);try{localStorage.setItem(draftKey,serializeRecoveryDraft(gestureHistory.current.current,projectDigest.current,savedRef.current));}catch{}}gestureHistory.current=null;activeGroup.current=null;},[]);
  const editTimelineZoom=useCallback((clipId:string,next:EditorZoom)=>change(p=>{
    const c=p.clips.find(v=>v.id===clipId),z=c?.zooms.find(v=>v.id===next.id);
    if(!z||z.startClipFrame===next.startClipFrame&&z.endClipFrame===next.endClipFrame&&z.transitionFrames===next.transitionFrames)return p;
    return {...p,clips:p.clips.map(v=>v.id===clipId?{...v,zooms:v.zooms.map(z=>z.id===next.id?next:z)}:v)};
  }),[change]);
  const editTimelineMotion=useCallback((clipId:string,next:MotionTrack)=>change(p=>{const current=p.clips.find(clip=>clip.id===clipId);if(!current?.motion.tracks.some(track=>track.id===next.id))return p;return {...p,clips:p.clips.map(clip=>clip.id===clipId?{...clip,motion:{...clip.motion,tracks:clip.motion.tracks.map(track=>track.id===next.id?next:track)}}:clip)};}),[change]);
  const editTimelineMotionLayer=useCallback((clipId:string,layerId:string,mode:'move'|'start'|'end',delta:number)=>{const base=gestureHistory.current?.current;change(project=>{const source=base??project,original=source.clips.find(item=>item.id===clipId),scheduled=scheduleProject(source).find(item=>item.clip.id===clipId);if(!original||!scheduled)return project;const motion=editMotionLayerSpan(original.motion,layerId,mode,delta,scheduled.durationFrames,source.output.fps,source.assets);return {...project,clips:project.clips.map(item=>item.id===clipId?{...item,motion}:item)};});},[change]);
  const editTimelineClip=useCallback((clipId:string,start:number,end:number)=>{const base=gestureHistory.current?.current;change(p=>{
    const c=p.clips.find(v=>v.id===clipId);return !c||c.trimStartSourceFrame===start&&c.trimEndSourceFrame===end?p:trimClip(base??p,clipId,start,end);
  });},[change]);
  const playPause=useCallback(()=>{if(recordingLock.current)return;const ref=player.current,p=currentRef.current;if(!ref||!p)return;if(ref.isPlaying()){ref.pause();return;}const next=startPlayback({...playbackSession.current,frame:ref.getCurrentFrame()},projectDuration(p));playbackSession.current=next.session;if(next.seekTo!==null){ref.seekTo(next.seekTo);setFrame(next.seekTo);}ref.play();},[]);
  const clearWordSelection=useCallback(()=>setWordSelection({ids:[],anchor:null}),[]);
  const selectWord=useCallback((wordId:string,multiple:boolean,range:boolean)=>{const p=currentRef.current;if(!p)return;const current=transcriptWords(p),row=current.find(row=>row.id===wordId);if(!row)return;setWordSelection(selection=>selectTimedWord(current,selection,wordId,multiple,range));setSelectedZoom(null);setFocusMode(false);setTab('transcript');seek(row.startFrame);},[seek]);
  const deleteWords=useCallback(()=>{const p=currentRef.current;if(!p||busyRef.current||activeGroup.current!==null)return;const ids=wordSelection.ids;try{cutSelectedWords(p,ids);change(latest=>latest.id===p.id?cutSelectedWords(latest,ids):latest);clearWordSelection();}catch(error){say(errorText(error),true);}},[wordSelection.ids,change,clearWordSelection,say]);
  useEffect(()=>{const valid=new Set(words.map(row=>row.id));setWordSelection(previous=>{const ids=previous.ids.filter(id=>valid.has(id)),anchor=previous.anchor&&valid.has(previous.anchor)?previous.anchor:null;return ids.length===previous.ids.length&&anchor===previous.anchor?previous:{ids,anchor};});},[words]);
  const load=useCallback((p:EditorProject,digest?:string|null)=>{projectOpenSeq.current++;projectDigest.current=digest;failedSaveSignature.current='';setSaveError(null);pause();clearWordSelection();setImportedSource(null);gestureHistory.current=null;activeGroup.current=null;setHistory({past:[],current:p,future:[]});setSaved(JSON.stringify(p));setSelectedIds([p.clips[0]!.id]);setSelectedZoom(null);setSelectedMotionLayerId('primary');setSelectedMotionTrackId(null);playbackSession.current=newPlaybackSession();setFrame(0);player.current?.seekTo(0);setFocusMode(false);setExportSize('native');},[pause,clearWordSelection]);
  const readCurrentProject=useCallback(()=>currentRef.current,[]),isEditing=useCallback(()=>activeGroup.current!==null||recordingLock.current,[]);
  const getPlayer=useCallback(()=>player.current,[]),setPresenterLock=useCallback((locked:boolean)=>{recordingLock.current=locked;},[]);
  const attachPresenter=useCallback((asset:EditorAsset,projectId:string,signature:string,maxFrames?:number)=>{
    const current=currentRef.current;
    if(!current||current.id!==projectId||JSON.stringify(current)!==signature||current.presenterTrack)return false;
    try{const generated={...createPresenterTrack(current,asset),style:preferredPresenterStyle()},track=maxFrames===undefined?generated:{...generated,segments:generated.segments.map(segment=>({...segment,endFrame:Math.min(segment.endFrame,maxFrames)}))};
      const next=EditorProjectSchema.parse({...current,assets:current.assets.some(item=>item.id===asset.id)?current.assets:[...current.assets,asset],presenterTrack:track});
      recordingLock.current=false;change(value=>value.id===projectId&&JSON.stringify(value)===signature?next:value);setTab('presenter');return true;
    }catch(error){say(errorText(error),true);return false;}
  },[change,say]);
  const retainPresenter=useCallback((asset:EditorAsset)=>setRetainedPresenterAssets(current=>current.some(item=>item.id===asset.id)?current:[...current,asset]),[]);
  const presenter=usePresenterRecorder({projectId:project?.id??null,readProject:readCurrentProject,getPlayer,setLock:setPresenterLock,attach:attachPresenter,retain:retainPresenter,notify:say});
  useEffect(()=>{const move=(event:PointerEvent)=>{const resizing=timelineResize.current;if(resizing)setTimelineHeight(Math.max(150,Math.min(Math.floor(window.innerHeight*.65),resizing.height+resizing.startY-event.clientY)));};const end=()=>{timelineResize.current=null;};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&timelineResize.current){timelineResize.current=null;event.preventDefault();}};window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);studioKeys.addEventListener('keydown',key);return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);studioKeys.removeEventListener('keydown',key);};},[]);
  manualUiRef.current={dialog,appSettingsOpen:showAppSettings,presenterRecording:presenter.active};
  const transcription=useTranscription({readProject:readCurrentProject,change,editing:isEditing,notify:say});
  // Any project with spoken audio gets a local transcript as soon as it opens, so the Words lane fills in by itself.
  const autoTranscribed=useRef(new Set<string>());
  useEffect(()=>{const p=currentRef.current;if(!p||recordingLock.current||transcription.info?.ready===false)return;
    for(const clip of p.clips){const asset=p.assets.find(item=>item.id===clip.assetId);
      if(!asset?.hasAudio||p.transcripts.some(item=>item.assetId===asset.id))continue;
      const key=`${p.id}:${asset.id}`;if(autoTranscribed.current.has(key))continue;autoTranscribed.current.add(key);
      try{if(!transcription.retarget(asset,p))transcription.start(asset,transcriptionTarget(p,asset.id));}catch{autoTranscribed.current.delete(key);}}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[project?.id,transcription.info?.ready]);
  /** Offer a browser draft back: resumable when its saved base is unchanged, otherwise only as a separate copy, on request. */
  const offerRecovery=(recovered:ReturnType<typeof parseRecoveryDraft>,opened:EditorProject,openedDigest:string)=>{
    const offer=(saved:EditorProject|null,digest:string,otherProject:boolean)=>{const same=!!saved&&recoveryMatchesSaved(recovered,saved,digest);
      setRecoveryOffer({draft:recovered.project,...(recovered.savedAt?{savedAt:recovered.savedAt}:{}),same,base:same?{digest,signature:JSON.stringify(saved)}:null,otherProject});};
    if(recovered.project.id===opened.id){offer(opened,openedDigest,false);return;}
    void request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(recovered.project.id)}`).then(other=>{if(JSON.stringify(other.project)!==JSON.stringify(recovered.project))offer(other.project,other.projectDigest,true);else{try{localStorage.removeItem(draftKey);}catch{}}}).catch(()=>offer(null,'',true));
  };
  const discardRecovery=()=>{try{localStorage.removeItem(draftKey);}catch{}setRecoveryOffer(null);};
  const restoreRecovery=(asCopy:boolean)=>{const offer=recoveryOffer;if(!offer)return;setRecoveryOffer(null);
    navigate(()=>{if(!asCopy&&offer.same&&offer.base){load(offer.draft,offer.base.digest);setSaved(offer.base.signature);savedRef.current=offer.base.signature;}else{load(recoveryCopy(offer.draft,id()),null);setSaved('');savedRef.current='';}setChooserOpen(false);});};
  useEffect(()=>{let alive=true; bootstrap(openVideoId).then(data=>{if(!alive)return;setStudioCapabilities((data as {capabilities?:unknown}).capabilities);setProjects(data.projects);setPresets(data.presets);const project0=data.project;if(openVideoId&&project0?.id!==openVideoId){askedVideo.current=openVideoId;void openProject(openVideoId);}if(!project0){setHistory(null);return;}const opened={...data,project:project0,projectDigest:data.projectDigest??''};load(opened.project,opened.projectDigest);if((data.job?.kind==='transcribe'||data.job?.kind==='model-download'))transcription.restore(data.job,opened.project,data.assets);else if(data.job?.kind==='export')setJob(data.job);if(data.job?.status==='running'&&data.job.kind==='export')setDialog('export');try{const raw=localStorage.getItem(draftKey);if(raw){const recovered=parseRecoveryDraft(raw);if(JSON.stringify(recovered.project)!==JSON.stringify(opened.project))offerRecovery(recovered,opened.project,opened.projectDigest);}}catch{/* A bad browser draft never prevents opening a saved project. */}}).catch(e=>{if(!alive)return;if((e as {code?:string}).code==='STUDIO_NOT_SET_UP'){setNotSetUp(true);return;}say(errorText(e),true);}).finally(()=>alive&&setBusy(null));return()=>{alive=false;};},[load,say]);
  useEffect(()=>{if(!dirty)return;const timer=setTimeout(()=>{try{localStorage.setItem(draftKey,serializeRecoveryDraft(project!,projectDigest.current,savedRef.current));}catch{say('The browser could not keep a recovery copy. Save the video to keep these edits.',true);}},600);return()=>clearTimeout(timer);},[dirty,serialized,say]);
  useEffect(()=>{const before=(e:BeforeUnloadEvent)=>{if(dirty||profileDirty||recordingLock.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[dirty,profileDirty]);
  useEffect(()=>{const node=stage.current;if(!node)return;const observer=new ResizeObserver(entries=>{const box=entries[0]?.contentRect;if(box&&box.width>0&&box.height>0)setPreviewBox({width:Math.max(100,box.width-48),height:Math.max(100,box.height-28)});});observer.observe(node);return()=>observer.disconnect();},[!!project]);
  useEffect(()=>{const ref=player.current;if(!ref)return;const onFrame=(e:{detail:{frame:number}})=>{presenter.noteFrame(e.detail.frame);playbackSession.current=progressPlayback(playbackSession.current,e.detail.frame);liveFrame.set(e.detail.frame);perfFrame(e.detail.frame);
    // While playing, the editor catches up ~5 times a second; the playhead and timecode follow every frame (live-frame.ts).
    const now=performance.now();if(!perf.throttle||!ref.isPlaying()||now-lastFrameCommit.current>=200){lastFrameCommit.current=now;setFrame(e.detail.frame);}}, onPlay=()=>{perfPlaying(true);setPlaying(true);},onPause=()=>{perfPlaying(false);setPlaying(false);const f=ref.getCurrentFrame();liveFrame.set(f);setFrame(f);};ref.addEventListener('frameupdate',onFrame);ref.addEventListener('play',onPlay);ref.addEventListener('pause',onPause);ref.addEventListener('ended',onPause);ref.addEventListener('ended',presenter.onEnded);ref.addEventListener('waiting',presenter.onWaiting);ref.addEventListener('waiting',perfWaiting);return()=>{ref.removeEventListener('frameupdate',onFrame);ref.removeEventListener('play',onPlay);ref.removeEventListener('pause',onPause);ref.removeEventListener('ended',onPause);ref.removeEventListener('ended',presenter.onEnded);ref.removeEventListener('waiting',presenter.onWaiting);ref.removeEventListener('waiting',perfWaiting);};},[!!project,presenter.noteFrame,presenter.onEnded,presenter.onWaiting]);
  useEffect(()=>{if(frame>=duration)seek(duration-1,false); if(project)setSelectedIds(ids=>{const next=ids.filter(v=>project.clips.some(c=>c.id===v));return next.length===ids.length?ids:next;});},[duration,project,frame,seek]);
  const save=useCallback(async()=>{
    if(saveInFlight.current)return saveInFlight.current;
    const p=currentRef.current;
    if(!p||busyRef.current||gestureHistory.current||activeGroup.current!==null||recordingLock.current)return false;
    const signature=JSON.stringify(p);
    const task=(async()=>{
      setSavingProject(true);setSaveError(null);
      try{
        let digest=projectDigest.current;
        if(digest===undefined){
          const remote=await request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(p.id)}`);
          if(JSON.stringify(remote.project)!==savedRef.current)throw new Error('This video changed somewhere else since you opened it. Your edits are kept here; open it again before saving.');
          digest=remote.projectDigest;
        }
        const result=await saveProject<{project:EditorProject;projectDigest:string}>(p.id,p,digest);
        if(currentRef.current?.id!==p.id)return false;
        projectDigest.current=result.projectDigest;
        savedRef.current=JSON.stringify(result.project);setSaved(savedRef.current);
        failedSaveSignature.current='';setSaveError(null);
        setProjects(list=>[...list.filter(v=>v.id!==p.id),{id:p.id,title:p.title}]);
        try{const current=currentRef.current;if(current&&JSON.stringify(current)!==savedRef.current)localStorage.setItem(draftKey,serializeRecoveryDraft(current,projectDigest.current,savedRef.current));else localStorage.removeItem(draftKey);}catch{}
        return true;
      }catch(error){
        if(currentRef.current?.id===p.id){failedSaveSignature.current=signature;setSaveError(errorText(error));try{localStorage.setItem(draftKey,serializeRecoveryDraft(currentRef.current,projectDigest.current,savedRef.current));}catch{}}
        return false;
      }finally{setSavingProject(false);saveInFlight.current=null;}
    })();
    saveInFlight.current=task;return task;
  },[]);
  useEffect(()=>{if(!dirty||!project||busy||saveError&&failedSaveSignature.current===serialized)return;let timer:ReturnType<typeof setTimeout>;let alive=true;
    const run=()=>{if(!alive)return;if(gestureHistory.current||activeGroup.current!==null||busyRef.current||recordingLock.current){timer=setTimeout(run,350);return;}void save();};
    timer=setTimeout(run,750);return()=>{alive=false;clearTimeout(timer);};
  },[dirty,serialized,project?.id,busy,saved,save,saveError]);
  const saveAll=useCallback(async()=>{
    if(profileEditor.current?.dirty()&&!await profileEditor.current.save())return false;
    for(let attempt=0;attempt<5;attempt++){
      if(currentRef.current&&JSON.stringify(currentRef.current)!==savedRef.current&&!await save())return false;
      if(!profileEditor.current?.dirty()&&(!currentRef.current||JSON.stringify(currentRef.current)===savedRef.current))return true;
    }
    say('Edits are still arriving. Finish editing and try again.',true);return false;
  },[save,say]);
  const startPresenterRecording=async()=>{if(recordingLock.current||busyRef.current)return;if(!await saveAll())return;if(recordingLock.current||busyRef.current)return;presenter.begin();};
  const useRetainedPresenter=(asset:EditorAsset)=>{const current=currentRef.current;if(!current||current.presenterTrack||recordingLock.current)return;attachPresenter(asset,current.id,JSON.stringify(current));};
  const split=useCallback(()=>{const p=currentRef.current;if(!p||selectedIds.length!==1)return;const s=scheduleProject(p).find(v=>v.clip.id===selectedIds[0]);if(!s||frame<=s.startFrame||frame>=s.startFrame+s.durationFrames){say('Place the playhead inside the selected clip to split it.');return;}change(v=>splitClip(v,s.clip.id,frame-s.startFrame));},[selectedIds,frame,change,say]);
  const editTyping=(action:'apply'|'all'|'reset'|'remove',target:string,rate:number)=>{
    const current=currentRef.current;if(!current)return;
    try{
      const next=action==='apply'?applyTypingSpeed(current,target,rate):action==='all'?applyAllTypingSpeeds(current,rate):action==='reset'?resetTypingSpeed(current,target):dismissTypingSuggestion(current,target);
      if(next===current)return;
      change(project=>project===current?next:project);
      if(action==='apply'){
        const created=next.clips.find(item=>item.playbackRate>1&&!current.clips.some(previous=>previous.id===item.id));
        if(created)setSelectedIds([created.id]);
      }
    }catch(error){say(errorText(error),true);}
  };
  const remove=useCallback(()=>{const p=currentRef.current;if(!p||selectedIds.length>=p.clips.length)return;change(v=>({...v,clips:v.clips.filter(c=>!selectedIds.includes(c.id)),voiceoverDraft:{...v.voiceoverDraft,targetClipIds:v.voiceoverDraft.targetClipIds.filter(clipId=>!selectedIds.includes(clipId))}}));setSelectedIds([]);},[selectedIds,change]);
  /** Punch-in: record a new take over the selected words, or insert one at the playhead. The Record dialog opens set up for
      it (the screen share in a browser needs the person's own click); the take lands in this edit as one undoable step. */
  const [punch,setPunch]=useState<PunchTarget|null>(null);
  const beginPunch=useCallback(async()=>{const p=currentRef.current;if(!p||recordingLock.current||manual.active||manual.working)return;const fps=p.output.fps,rows=transcriptWords(p),schedule=scheduleProject(p);
    let from=frame,to=frame;
    const words=rows.filter(row=>wordSelection.ids.includes(row.id));
    if(words.length){const ranges=wordCutRanges(rows,words,fps);from=Math.min(...ranges.map(r=>r.startFrame));to=Math.max(...ranges.map(r=>r.endFrame));}
    // Only highlighted words mark a stretch to replace; otherwise the take goes in at the playhead (a selected clip is not a punch range).
    void schedule;
    const time=(f:number)=>secondsLabel(f/fps);
    const target:PunchTarget={projectId:p.id,fromFrame:from,toFrame:to,...(p.slideDeck?{deckId:p.slideDeck.id}:{}),label:to>from?`Replaces ${time(from)}–${time(to)} in “${p.title}”. Everything else stays as it is.`:`Inserts the new take at ${time(from)} in “${p.title}”.`};
    pause();
    setPunch(target);setDialog('record');void manual.refreshSessions();
  },[frame,wordSelection.ids,selectedIds,manual,pause]);
  const removeSelectionRef=useRef<()=>void>(()=>{});
  /** Delete with a zoom selected removes only that zoom — never the clip it sits on. */
  const removeSelectedZoom=useCallback(()=>{const zoomId=selectedZoom;if(!zoomId)return;change(p=>({...p,clips:p.clips.map(clip=>clip.zooms.some(z=>z.id===zoomId)?{...clip,zooms:clip.zooms.filter(z=>z.id!==zoomId)}:clip)}));setSelectedZoom(null);},[selectedZoom,change]);
  /** One click: cut filler sounds, filler "like", "you know" asides and stutters from picture, voice, camera and slides together. */
  const cleanUp=useCallback(()=>{const p=currentRef.current;if(!p||busyRef.current||activeGroup.current!==null)return;
    const found=cleanupWords(transcriptWords(p));if(!found.length){say('No filler words or repeats found');return;}
    const ranges=wordCutRanges(transcriptWords(p),found,p.output.fps);
    try{deleteTimelineRanges(p,ranges);change(latest=>latest.id===p.id?deleteTimelineRanges(latest,ranges):latest);clearWordSelection();
      say(`Removed ${found.length} filler word${found.length===1?'':'s'} and repeat${found.length===1?'':'s'} · ⌘Z to undo`,false,{undo:true});}catch(error){say(errorText(error),true);}},[change,clearWordSelection,say]);
  useEffect(()=>{const handle=(e:KeyboardEvent)=>{if(e.defaultPrevented||e.isComposing)return;const target=e.target instanceof HTMLElement?e.target:document.body; const command=e.metaKey||e.ctrlKey;if(recordingLock.current){if(command&&['s','z'].includes(e.key.toLowerCase())||['Space','ArrowLeft','ArrowRight','Backspace','Delete'].includes(e.code))e.preventDefault();return;}if(command&&e.key.toLowerCase()==='s'){e.preventDefault();if(!dialog)void saveAll();return;}if(chooserOpen)return;if(pageRef.current!=='edit'&&!showAppSettings){if(command&&e.key.toLowerCase()==='z'&&!dialog&&!target.isContentEditable&&!target.closest('input,select,[role=combobox],textarea,[role=dialog]')){e.preventDefault();if(e.shiftKey)redo();else undo();}return;}if(showAppSettings||gestureHistory.current||dialog||motionControlOwnsKey(target,e.key,command)||target.closest('.project-sidebar')||target.closest('.asset-browser')||target.isContentEditable||target.closest('input,select,[role=combobox],textarea,[role=dialog],[contenteditable=true],[contenteditable=plaintext-only]'))return;if(command&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();window.dispatchEvent(new CustomEvent('ni-studio-timeline-zoom',{detail:{axis:e.key==='ArrowLeft'||e.key==='ArrowRight'?'time':'lanes',direction:e.key==='ArrowRight'||e.key==='ArrowUp'?1:-1}}));}else if(command&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();}else if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!target.closest('button,[role=button],a,input,textarea,select')){e.preventDefault();player.current?.pause();playbackSession.current={...playbackSession.current,frame:0,startFrame:0};seek(0);}else if(!command&&!e.altKey&&(e.key==='a'||e.key==='A')){e.preventDefault();setAutomationView(v=>!v);}else if(e.code==='Space'||e.key===' '){const blocked=!!target.closest('input,textarea,select,[role=combobox],[contenteditable=true],[contenteditable=plaintext-only],[role=dialog]');const toggle=spacePlaybackAllowed(e,blocked);if(!blocked&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();if(toggle)playPause();}}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();seek(frame+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?10:1));}else if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();removeSelectionRef.current();}};studioKeys.addEventListener('keydown',handle);return()=>studioKeys.removeEventListener('keydown',handle);},[dialog,frame,redo,undo,saveAll,playPause,seek,remove,wordSelection.ids,deleteWords,showAppSettings,selectedZoom,removeSelectedZoom,chooserOpen]);
  // ⌘O shows the projects (and hides them again when a project is open).
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(!(e.metaKey||e.ctrlKey)||e.key.toLowerCase()!=='o'||e.shiftKey||e.altKey)return;e.preventDefault();if(dialog||showAppSettings||recordingLock.current)return;setChooserOpen(open=>currentRef.current?!open:true);};studioKeys.addEventListener('keydown',key);return()=>studioKeys.removeEventListener('keydown',key);},[dialog,showAppSettings]);
  const append=useCallback((asset:EditorAsset)=>{const clipId=id();change(p=>({...p,assets:p.assets.some(a=>a.id===asset.id)?p.assets:[...p.assets,asset],clips:[...p.clips,{id:clipId,assetId:asset.id,trimStartSourceFrame:0,trimEndSourceFrame:asset.sourceFrames!,audio:{muted:false,gain:1},holdEndFrames:0,playbackRate:1,dismissedActionIndices:[],zooms:[],motion:neutralMotion()}]}));setSelectedIds([clipId]);setSelectedZoom(null);setSelectedMotionLayerId('primary');setSelectedMotionTrackId(null);setTab('clip');return clipId;},[change]);
  const beginImport=(kind:'video'|'image'|'audio')=>{if(busy||recordingLock.current)return;importKind.current=kind;if(fileInput.current){fileInput.current.accept=kind==='video'?'video/*':kind==='image'?'image/png,image/jpeg,image/webp':'audio/*';fileInput.current.click();}};
  /** Put a freshly imported asset into the film: video as a clip, sound as a track, a still as the background. */
  const placeImported=(asset:EditorAsset,original:EditorProject)=>{let clipIds:string[]=[],segmentIds:string[]=[];
    if(asset.kind==='video')clipIds=[append(asset)];else {const trackId=id(),segmentId=id();if(asset.kind==='audio')segmentIds=[segmentId];change(p=>p.id!==original.id?p:({...p,assets:p.assets.some(a=>a.id===asset.id)?p.assets:[...p.assets,asset],...(asset.kind==='image'?{presentation:{...p.presentation,background:{...p.presentation.background,kind:'image' as const,assetId:asset.id}}}:{audioTracks:[...p.audioTracks,{id:trackId,name:asset.name,role:'voiceover' as const,gain:1,muted:false,segments:[{id:segmentId,assetId:asset.id,startFrame:0,trimStartSeconds:0,trimEndSeconds:asset.durationSeconds!}]}]})}));}
    if(asset.kind!=='image'){setImportedSource({assetId:asset.id,token:id()});setTab('transcript');if(asset.hasAudio){const imported={...original,assets:original.assets.some(a=>a.id===asset.id)?original.assets:[...original.assets,asset]};transcription.start(asset,transcriptionTarget(imported,asset.id,clipIds,segmentIds));say(`${asset.name} imported. Transcribing it now.`);}else say(`${asset.name} imported. This recording has no audio stream to transcribe.`);}else say(`${asset.name} imported`);
  };
  const importMediaFile=async(file:File,expected:ImportKind,fromDrop=false)=>{if(recordingLock.current){say('Stop the presenter recording before importing media.',true);return;}const original=currentRef.current;if(!original||busyRef.current||fileImportLock.current)return;fileImportLock.current=true;setBusy(`Importing ${file.name}`);try{const {asset}=await importFile<{asset:EditorAsset}>(file);if(asset.kind!==expected)throw new Error(`Choose a ${expected} file.`);if(currentRef.current?.id!==original.id)return;placeImported(asset,original);
  }catch(error){say(errorText(error),true);}finally{fileImportLock.current=false;setBusy(null);}};
  /** Add a file from the Browser: the server imports it from its folder (no upload), then it lands like any import. */
  const importFromBrowser=async(item:BrowserItem)=>{if(recordingLock.current){say('Stop the presenter recording before importing media.',true);return;}const original=currentRef.current;if(!original||busyRef.current||fileImportLock.current)return;fileImportLock.current=true;setBusy(`Adding ${item.name}`);try{const {asset}=await browserImport(item);if(currentRef.current?.id!==original.id)return;placeImported(asset,original);
  }catch(error){say(errorText(error),true);}finally{fileImportLock.current=false;setBusy(null);}};

  const onImport=async(e:React.ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0];e.target.value='';if(file)await importMediaFile(file,importKind.current);};
  const resetFileDrag=()=>{fileDragDepth.current=0;setFileDrag(false);};
  useEffect(()=>{const reset=()=>{fileDragDepth.current=0;setFileDrag(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')reset();};window.addEventListener('blur',reset);window.addEventListener('dragend',reset);studioKeys.addEventListener('keydown',escape);return()=>{window.removeEventListener('blur',reset);window.removeEventListener('dragend',reset);studioKeys.removeEventListener('keydown',escape);};},[]);
  const externalDrag=(e:React.DragEvent)=>fileTransfer(Array.from(e.dataTransfer.types))||e.dataTransfer.types.includes(BROWSER_DRAG);
  const onFileDrop=(e:React.DragEvent)=>{if(!externalDrag(e))return;e.preventDefault();resetFileDrag();if(showAppSettings){say('Go back to the video to import media.',true);return;}if(recordingLock.current){say('Stop the presenter recording before importing media.',true);return;}if(!currentRef.current||busyRef.current||fileImportLock.current||dialog||gestureHistory.current||false){say('Finish the current operation before dropping a file.',true);return;}const fromBrowser=e.dataTransfer.getData(BROWSER_DRAG);if(fromBrowser){if(!(e.target as HTMLElement).closest('.asset-browser'))void importFromBrowser(JSON.parse(fromBrowser) as BrowserItem);return;}const result=droppedMedia(Array.from(e.dataTransfer.files));if('error'in result){say(result.error,true);return;}void importMediaFile(result.file,result.kind,true);};

  const changeClip=(fn:(c:EditorClip)=>EditorClip)=>{if(!clip)return;change(p=>{const current=p.clips.find(c=>c.id===clip.id)!;const next=fn(current);if(next.trimStartSourceFrame!==current.trimStartSourceFrame||next.trimEndSourceFrame!==current.trimEndSourceFrame)return trimClip(p,current.id,next.trimStartSourceFrame,next.trimEndSourceFrame);return {...p,clips:p.clips.map(c=>c.id===clip.id?next:c)};});};
  const changeZoom=(fn:(z:EditorZoom)=>EditorZoom)=>{if(!zoom)return;changeClip(c=>{const current=c.zooms.find(z=>z.id===zoom.id)!;const next=fn(current);if(c.zooms.some(z=>z.id!==next.id&&next.startClipFrame<z.endClipFrame&&next.endClipFrame>z.startClipFrame)){say('Zoom segments cannot overlap. Adjust the start or end to leave room.',true);return c;}return {...c,zooms:c.zooms.map(z=>z.id===zoom.id?{...next,transitionFrames:Math.min(next.transitionFrames,Math.floor((next.endClipFrame-next.startClipFrame)/2))}:z)};});};
  const [automationView,setAutomationView]=useState(false);
  /** A timeline layer (text, callout, spotlight) whose settings fill the inspector. */
  const [selectedLayerId,setSelectedLayerId]=useState<string|null>(null);
  useEffect(()=>{setSelectedLayerId(null);},[selectedIds,project?.id]);
  // A take or an edit by the agent can split or replace clips: forget selections of clips that no longer exist.
  useEffect(()=>{if(!project)return;const ids=new Set(project.clips.map(c=>c.id));setSelectedIds(current=>current.every(id=>ids.has(id))?current:(()=>{const kept=current.filter(id=>ids.has(id));return kept.length?kept:[project.clips[0]!.id];})());},[project]);
  /** Storyboard beats selected on the Storyboard track (a run of beats, to record into or edit). */
  const [selectedBeatIds,setSelectedBeatIds]=useState<string[]>([]);
  useEffect(()=>{setSelectedBeatIds([]);},[project?.id]);
  /** Pages: Overview, Storyboard and Cast for planning and generating; Edit is the editor. Remembered per project. */
  const [page,setPageState]=useState<FilmPage>('edit');
  useLayoutEffect(()=>{const p=currentRef.current;if(p)setPageState(openPage&&p.id===openVideoId?openPage:initialPage(p));},[project?.id]);
  // The page was asked for another video while the Studio is open (the agent shows the one it just made).
  const askedVideo=useRef<string|null>(openVideoId), seenAsk=useRef(openAsk);
  useEffect(()=>{if(seenAsk.current!==openAsk){seenAsk.current=openAsk;askedVideo.current=null;}if(!openVideoId)return;if(askedVideo.current===openVideoId){if(openPage&&currentRef.current?.id===openVideoId&&pageRef.current!==openPage)setPageState(openPage);return;}askedVideo.current=openVideoId;if(currentRef.current?.id!==openVideoId)navigate(()=>{void openProject(openVideoId);});else if(openPage)setPageState(openPage);},[openVideoId,openPage,openAsk]);
  pageRef.current=page;
  const onPlaceRef=useRef(onPlace);onPlaceRef.current=onPlace;
  useEffect(()=>{onPlaceRef.current?.({videoId:project?.id??null,title:project?.title??null,page});},[project?.id,project?.title,page]);
  // A save made after the draft was taken (autosave, the agent) means the draft can no longer resume in place.
  useEffect(()=>{setRecoveryOffer(offer=>offer&&offer.same&&offer.base&&!offer.otherProject&&project?.id===offer.draft.id&&saved!==offer.base.signature?{...offer,same:false,base:null}:offer);},[saved,project?.id]);
  const setPage=(next:FilmPage)=>{setPageState(next);const p=currentRef.current;if(p)rememberPage(p.id,next);if(next!=='edit')pause();};
  const selectedLayer=selectedLayerId?project?.layers?.find(layer=>layer.id===selectedLayerId)??null:null;
  /** Audio segments and layers picked on the timeline (click, Shift/⌘-click, marquee, ⌘A). One layer alone opens the layer inspector. */
  const [selectedItems,setSelectedItems]=useState<TimelineItem[]>([]);
  useEffect(()=>{setSelectedItems([]);},[selectedIds,project?.id]);
  useEffect(()=>{if(project)setSelectedItems(current=>{const live=liveItems(project,current);return live.length===current.length?current:live;});},[project]);
  const selectItems=useCallback((items:TimelineItem[])=>{setSelectedItems(items);const only=items.length===1?items[0]:undefined;setSelectedLayerId(only?.kind==='layer'?only.id:null);
    if(items.length){setSelectedBeatIds([]);clearWordSelection();setSelectedZoom(null);setSelectedMotionLayerId('primary');setSelectedMotionTrackId(null);setFocusMode(false);setShowAppSettings(false);if(only?.kind==='audio')setTab('audio');}},[clearWordSelection]);
  /** Delete / Backspace and the trash button remove whatever is selected, most specific first: words, picked audio segments and layers, a layer, beats, a zoom, a motion layer, then clips. */
  const removeSelection=()=>{if(wordSelection.ids.length){deleteWords();return;}
    if(selectedItems.length){const items=selectedItems;change(p=>removeItems(p,items));selectItems([]);return;}
    if(selectedLayer){const layerId=selectedLayer.id;change(p=>({...p,layers:(p.layers??[]).filter(layer=>layer.id!==layerId)}));setSelectedLayerId(null);return;}
    if(selectedBeatIds.length){const ids=selectedBeatIds;change(p=>applyOps(p,ids.map(id=>({op:'remove_beat',args:{id}}))).project);setSelectedBeatIds([]);return;}
    if(selectedZoom){removeSelectedZoom();return;}
    const motionClip=selectedIds.length===1?project?.clips.find(c=>c.id===selectedIds[0]):undefined,layerId=selectedMotionLayerId;
    if(motionClip&&layerId!=='primary'&&motionClip.motion.layers.some(layer=>layer.id===layerId)){change(p=>({...p,clips:p.clips.map(c=>c.id===motionClip.id?{...c,motion:{...c.motion,layers:c.motion.layers.filter(layer=>layer.id!==layerId),tracks:c.motion.tracks.filter(track=>track.target!==layerId)}}:c)}));setSelectedMotionLayerId('primary');setSelectedMotionTrackId(null);return;}
    remove();};
  removeSelectionRef.current=removeSelection;
  /** Add zoom: a smooth zoom in and out at the playhead on the timeline-wide Zoom lane (whatever is in front zooms). */
  /** Open the inspector on a tab because the person asked (a layer just added, a layout to finish): `undefined` keeps its tab. */
  const showInspector=(next?:InspectorTab)=>{const shown=showInspectorTab({open:inspectorOpen,tab},next);setTab(shown.tab);setInspectorOpen(true);};
  /** The ⋯ menu's Cursor: the edit page, nothing picked that would fill the inspector instead, and the inspector open on the cursor's settings. */
  const showCursor=()=>{if(page!=='edit')setPage('edit');selectItems([]);setSelectedBeatIds([]);setFocusMode(false);showInspector('cursor');};
  const addZoom=()=>{if(!project)return;change(p=>addZoomBump(p,frame,projectDuration(p)));setAutomationView(true);say('Zoom added at the playhead · shape it on the Zoom lane');};
  const reorder=(source:string,target:string)=>{if(source===target)return;change(p=>{const clips=[...p.clips],from=clips.findIndex(c=>c.id===source),to=clips.findIndex(c=>c.id===target);if(from<0||to<0)return p;const [moved]=clips.splice(from,1);clips.splice(to,0,moved!);return {...p,clips};});};
  const openProject=async(projectId:string)=>{const token=++projectOpenSeq.current,navToken=navigationSeq.current;pause();setBusy('Opening video');try{const data=await request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(projectId)}`);if(token!==projectOpenSeq.current||navToken!==navigationSeq.current)return false;load(data.project,data.projectDigest);setBusy(null);localStorage.removeItem(draftKey);setDialog(null);setPendingProject(null);return true;}catch(e){if(token===projectOpenSeq.current&&navToken===navigationSeq.current)say(errorText(e),true);return false;}finally{if(token===projectOpenSeq.current&&navToken===navigationSeq.current)setBusy(null);}};
  const openRecordingProject=(next:EditorProject)=>{load(next,null);setSaved('');setTab('transcript');setImportedSource({assetId:next.assets[0]!.id,token:id()});setPendingRecording(null);setPendingProject(null);setDialog(null);const asset=next.assets[0]!;if(!transcription.retarget(asset,next)&&!next.transcripts.some(t=>t.assetId===asset.id)&&asset.hasAudio)transcription.start(asset,transcriptionTarget(next,asset.id));};
  const newRecordingProject=(asset:EditorAsset)=>{if(busyRef.current)return;try{const current=currentRef.current;if(!current)return;const next=projectFromRecording(current,asset,id(),id());navigate(()=>openRecordingProject(next));}catch(error){say(errorText(error),true);}};
  const navigate=(action:(token:number)=>Promise<void>|void)=>{if(presenter.phase==='ready'||presenter.phase==='requesting')presenter.cancel();if(recordingLock.current){say('Stop the presenter recording before switching videos.',true);return;}if(busyRef.current&&busyRef.current!=='Opening video')return;const token=++navigationSeq.current;projectOpenSeq.current++;if(profileEditor.current?.dirty()){pendingNavigation.current=()=>action(token);setPendingProject('action');setDialog('navigate');return;}if(currentRef.current&&JSON.stringify(currentRef.current)!==savedRef.current){void saveAll().then(ok=>{if(ok&&token===navigationSeq.current)void action(token);});return;}if(token===navigationSeq.current)void action(token);};
  const openRecording=(projectId:string)=>navigate(async()=>{await openProject(projectId);});
  const manualOpenContext=()=>{const current=currentRef.current,signature=current?JSON.stringify(current):null,ui=manualUiRef.current;return {navigationToken:navigationSeq.current,projectId:current?.id??null,projectSignature:signature,workspaceId:null,editDirty:!!current&&signature!==savedRef.current,scriptDirty:false,profileDirty:!!profileEditor.current?.dirty(),busy:!!busyRef.current,gestureEditing:activeGroup.current!==null||!!gestureHistory.current,appSettingsOpen:ui.appSettingsOpen,otherDialogOpen:!!ui.dialog&&ui.dialog!=='record',presenterRecording:ui.presenterRecording};};
  const startManualRecording=async(options:RecordingStart)=>{
    if(manual.active||manual.working||busyRef.current||recordingLock.current||running)return null;
    const before={...manualOpenContext(),sessionId:''};
    if(!await saveAll())return null;
    if(!manualOriginMatches(before,manualOpenContext()))return null;
    const current=currentRef.current,origin={navigationToken:navigationSeq.current,projectId:current?.id??null,projectSignature:current?JSON.stringify(current):null,workspaceId:null};
    pause();
    const session=await manual.start(options);
    if(session){setManualIntent({...origin,sessionId:session.id});setManualFollowUp(null);}
    return session;
  };
  /** Record into storyboard placeholders: the Record dialog opens set up for those beats (their stretch of the timeline,
      their lines on the teleprompter); after a countdown, the take lands in those beats. */
  const recordBeats=async(ids:string[])=>{const p=currentRef.current;if(!p?.storyboard||!ids.length||recordingLock.current||manual.active||manual.working)return;
    try{
      const slot=slotFor(p.storyboard,ids),time=(f:number)=>secondsLabel(f/p.output.fps);
      pause();setPunch({projectId:p.id,fromFrame:slot.from,toFrame:slot.to,beatIds:ids,prompter:prompterFor(slot.beats,p.output.fps),
        label:`${ids.length===1?'1 beat':`${ids.length} beats`} · ${time(slot.from)}–${time(slot.to)} in “${p.title}”. Next line on the teleprompter marks where each beat starts.`});
      setSelectedBeatIds([]);setDialog('record');void manual.refreshSessions();
    }catch(error){say(errorText(error),true);}
  };
  const openManualProject=async(session:RecordingSession)=>{
    if(!session.projectId||manualOpenLock.current)return;
    manualOpenLock.current=true;
    const origin={...manualOpenContext(),sessionId:session.id};
    let openToken:number|undefined;
    try{
      if(!await saveAll()){setManualFollowUp(session);return;}
      if(!manualContextUnchanged(origin,manualOpenContext())){setManualFollowUp(session);return;}
      const token=++navigationSeq.current;openToken=token;projectOpenSeq.current++;
      const ready={...manualOpenContext(),sessionId:session.id};
      setBusy('Opening recording');
      const result=await request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(session.projectId)}`);
      const latest=manualOpenContext();
      if(token!==navigationSeq.current||!manualContextUnchanged(ready,{...latest,busy:latest.busy&&busyRef.current!=='Opening recording'})){
        setManualFollowUp(session);return;
      }
      // A take recorded into this edit lands as ONE undoable step (⌘Z takes the whole take away); a new recording opens fresh.
      const sameEdit=!!session.punch&&currentRef.current?.id===result.project.id;
      if(sameEdit){projectDigest.current=result.projectDigest;savedRef.current=JSON.stringify(result.project);setSaved(savedRef.current);
        setHistory(h=>h&&h.current.id===result.project.id?{past:[...h.past,h.current].slice(-80),current:result.project,future:[],group:null}:h);}
      else load(result.project,result.projectDigest);
      setShowAppSettings(false);setProjects(items=>[...items.filter(item=>item.id!==result.project.id),{id:result.project.id,title:result.project.title}]);
      setDialog(null);setTab('transcript');setManualFollowUp(null);
      // The voice to transcribe: the take's own microphone when it was recorded as its own file, else the screen take.
      const screenId=session.voiceAssetId??session.screenAssetId??result.project.clips[0]?.assetId,screen=screenId?result.project.assets.find(asset=>asset.id===screenId):undefined;
      if(screen){setImportedSource({assetId:screen.id,token:id()});if(screen.hasAudio&&!result.project.transcripts.some(item=>item.assetId===screen.id)){
        if(!transcription.retarget(screen,result.project))transcription.start(screen,transcriptionTarget(result.project,screen.id));
        say('Recording ready. Transcribing it now.');
      }else if(!screen.hasAudio)say('Recording ready. This take has no audio stream to transcribe.');
      else say(sameEdit?'Take placed · ⌘Z removes the whole take':'Recording ready in editor',false,{undo:sameEdit});}else say(sameEdit?'Take placed · ⌘Z removes the whole take':'Recording ready in editor',false,{undo:sameEdit});
    }catch(error){setManualFollowUp(session);say(`Could not open the recording: ${errorText(error)}`,true);}
    finally{manualOpenLock.current=false;if(openToken===navigationSeq.current)setBusy(null);}
  };
  const openManualPartial=async(session:RecordingSession)=>{
    if(!session.partialAssetId||manual.active||manual.working)return;
    const before={...manualOpenContext(),sessionId:session.id};
    if(!await saveAll())return;
    if(!manualOriginMatches(before,manualOpenContext())){setManualFollowUp(session);return;}
    const ready={...manualOpenContext(),sessionId:session.id};
    const project=await manual.openPartial(session.id);
    if(!project)return;
    const completed={...session,projectId:project.id};
    if(!manualContextUnchanged(ready,manualOpenContext())){setManualFollowUp(completed);return;}
    await openManualProject(completed);
  };
  const manualIntentSession=manualIntent?manual.sessions.find(item=>item.id===manualIntent.sessionId):undefined;
  useEffect(()=>{
    const session=manualIntentSession,intent=manualIntent;
    if(!session||!intent||!['completed','failed','cancelled','interrupted'].includes(session.status))return;
    setManualIntent(null);
    if(claimedManualSessions.current.has(session.id))return;
    claimedManualSessions.current.add(session.id);
    // The sync check after a take (a camera that started late or stopped early) is worth seeing right away.
    if(session.status==='completed'&&session.note)say(session.note,true);
    // A take that stopped before it started (a camera missing, a window closed) says why instead of just ending.
    if(session.status!=='completed'&&session.error)say(`The recording stopped: ${session.error}`,true);
    const safe=canAutoOpenManual(intent,session,manualOpenContext());
    if(safe)void openManualProject(session);else{setManualFollowUp(session);if(session.status==='completed'&&session.projectId)say(session.punch?'Your take is ready.':'Your recording is ready as its own video.',false,{open:()=>void openManualProject(session)});}
  },[manualIntent?.sessionId,manualIntentSession?.status,manualIntentSession?.projectId]);
  // A take this tab did not start from Record (one brought back after its window closed) ends with nobody waiting for
  // it: say it is ready, with Open, and leave the follow-up, unless the Record dialog is showing it.
  useEffect(()=>{for(const session of manual.sessions){if(session.status!=='completed'||!session.projectId||claimedManualSessions.current.has(session.id)||manualIntent?.sessionId===session.id)continue;
    claimedManualSessions.current.add(session.id);if(manualUiRef.current.dialog==='record')continue;setManualFollowUp(session);say('Your recording is ready as its own video.',false,{open:()=>void openManualProject(session)});}
  },[manual.sessions]);// eslint-disable-line react-hooks/exhaustive-deps
  // Edits saved from outside the window (the agent in the app's chat, the MCP server) show up here within a couple of seconds.
  useEffect(()=>{const timer=setInterval(()=>{const current=currentRef.current;if(!current||gestureHistory.current||activeGroup.current!==null||document.hidden||recordingLock.current)return;
    if(JSON.stringify(current)!==savedRef.current)return;
    void request<{projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(current.id)}/digest`).then(remote=>{if(remote.projectDigest&&projectDigest.current&&remote.projectDigest!==projectDigest.current&&currentRef.current?.id===current.id)void adoptAgentEditRef.current?.();}).catch(()=>{});},2000);
    return()=>clearInterval(timer);},[]);
  const adoptAgentEditRef=useRef<(()=>Promise<void>)|null>(null);
  // The agent saves through the server; take its version as one undoable step when this edit has no newer local changes.
  const adoptAgentEdit=useCallback(async()=>{
    const current=currentRef.current;if(!current)return;
    try{const remote=await request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(current.id)}`);
      if(remote.projectDigest===projectDigest.current||currentRef.current?.id!==remote.project.id)return;
      if(JSON.stringify(currentRef.current)!==savedRef.current){setAgentUpdate(remote.project.id);return;}
      projectDigest.current=remote.projectDigest;savedRef.current=JSON.stringify(remote.project);setSaved(savedRef.current);
      setHistory(h=>h&&h.current.id===remote.project.id?{past:[...h.past,h.current].slice(-80),current:remote.project,future:[],group:null}:h);
      say('This video was updated. Undo reverts it.',false,{undo:true});
    }catch(error){say(errorText(error),true);}
  },[say]);
  adoptAgentEditRef.current=adoptAgentEdit;
  // The agent in the app's chat is the Studio's agent. When the person messages it with the Studio in front, the card
  // store reads what the editor shows at that moment (chat-note.ts) after saving their edits first (flushForChat), so
  // the agent edits what they see and its edit comes back as one undoable step, not as a conflict.
  const chatNote=useRef<()=>ReturnType<typeof editorChatNote>>(()=>null);
  chatNote.current=()=>editorChatNote({project:currentRef.current,page,frame:playing?liveFrame.get():frame,selectedIds,selectedItems,selectedLayerId,selectedBeatIds,selectedZoom,selectedMotionLayerId,selectedMotionTrackId,dirty:!!currentRef.current&&JSON.stringify(currentRef.current)!==savedRef.current});
  const flushForChat=useCallback(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      const current=currentRef.current;if(!current||JSON.stringify(current)===savedRef.current)return true;
      if(gestureHistory.current||activeGroup.current!==null||recordingLock.current||busyRef.current)return false;
      if(!await save())return false;
    }
    return !currentRef.current||JSON.stringify(currentRef.current)===savedRef.current;
  },[save]);
  const onLiveRef=useRef(onLive);onLiveRef.current=onLive;
  useEffect(()=>{const tell=onLiveRef.current;if(!tell)return;tell({note:()=>chatNote.current(),flush:flushForChat});return()=>tell(null);},[flushForChat]);
  // A video made from a description: once it is open, the description goes to the agent in the app's chat as the person's message.
  useEffect(()=>{const brief=agentBrief;if(!brief||project?.id!==brief.projectId)return;setAgentBrief(null);
    void (async()=>{await saveAll();const result=await askAgentInChat(brief.text);if(!result.ok)say(result.reason,true);})();},[agentBrief,project?.id,saveAll,say]);
  /** "Load its version": the agent's save becomes the current state, one undoable step (⌘Z brings these edits back). */
  const loadAgentVersion=async()=>{const current=currentRef.current;if(!current)return;
    try{const remote=await request<{project:EditorProject;projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(current.id)}`);if(currentRef.current?.id!==remote.project.id)return;
      projectDigest.current=remote.projectDigest;savedRef.current=JSON.stringify(remote.project);setSaved(savedRef.current);failedSaveSignature.current='';setSaveError(null);setAgentUpdate(null);
      setHistory(h=>h&&h.current.id===remote.project.id?{past:[...h.past,h.current].slice(-80),current:remote.project,future:[],group:null}:h);
      say('Loaded the agent’s version · ⌘Z brings yours back',false,{undo:true});}catch(error){say(errorText(error),true);}};
  /** "Keep mine": save these edits over the agent's version (it stays in the project's version history). */
  const keepLocalVersion=async()=>{const current=currentRef.current;if(!current)return;
    try{const remote=await request<{projectDigest:string}>(`/api/account/studio/projects/${encodeURIComponent(current.id)}/digest`);if(currentRef.current?.id!==current.id)return;
      projectDigest.current=remote.projectDigest;failedSaveSignature.current='';setSaveError(null);setAgentUpdate(null);void save();}catch(error){say(errorText(error),true);}};
  const closeDialog=useCallback(()=>setDialog(null),[]);
  // Arriving from the desktop app to download a large export here (export-arrival.ts): once the video is open, its
  // finished export is downloaded once through this browser's session and shown in the Export dialog.
  const [exportNotice,setExportNotice]=useState<{tone:'ok'|'warn';text:string}|null>(null);
  useExportArrival(project?.id??null,{openVideo:id=>new Promise<boolean>(resolve=>navigate(async()=>{resolve(await openProject(id));})),
    getJob:id=>request<{job:EditorJob}>(`/api/account/studio/jobs/${encodeURIComponent(id)}`).then(r=>r.job),
    download:async done=>{await saveExport({url:done.downloadUrl!,fileName:exportFileName(done.downloadUrl!,project?.title||'video')},'downloads');},
    show:shown=>{if('job' in shown&&shown.job)setJob(shown.job);setExportNotice(arrivalNotice(shown));setDialog('export');}});
  useEffect(()=>{if(!job||job.status!=='running')return;let alive=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const result=await request<{job:EditorJob}>(`/api/account/studio/jobs/${job.id}`);if(!alive)return;setJob(result.job);if(result.job.status==='failed')say(result.job.error??'The export failed. Try again.',true);if(result.job.status==='completed'&&result.job.kind==='export'){const done=result.job,of=done.videoId??(exportReceiptRef.current?.jobId===done.id?exportReceiptRef.current.projectId:null);
  // Open goes to the video it was made from, whichever is open now.
  const open=()=>{if(!of||currentRef.current?.id===of){setDialog('export');return;}navigate(async()=>{if(await openProject(of))setDialog('export');});};
  // One this device started is saved only once its app says so (local-export.ts whenSavedHere); else the server's word.
  if(done.where!=='computer')say('Your export is ready to save.',false,{open});
  else if(isDesktopApp()&&destinationOf(done.id))void whenSavedHere(done.id,studioLocalExport).then(outcome=>{const words=finishedWords(done,outcome);say(words.text,words.error,{open});});
  else{const words=finishedWords(done,null);say(words.text,words.error,{open});}}if(result.job.status==='running')timer=setTimeout(poll,700);}catch(e){if(alive){say(errorText(e),true);timer=setTimeout(poll,2500);}}};timer=setTimeout(poll,700);return()=>{alive=false;clearTimeout(timer);};},[job?.id,job?.status,append,say]);
  const exportProject=()=>{if(!project)return null;if(exportSize==='native')return project;const targetHeight=Math.min(1080,project.output.height),factor=targetHeight/project.output.height;const p=project.presentation;const clips=project.clips.map(clip=>({...clip,motion:{...clip.motion,layers:clip.motion.layers.map(layer=>layer.kind==='text'?{...layer,fontSizePx:Math.max(.1,layer.fontSizePx*factor)}:layer.kind==='frame'?{...layer,strokeWidthPx:Math.max(.01,layer.strokeWidthPx*factor),radiusPx:layer.radiusPx*factor}:layer.kind==='highlight'?{...layer,radiusPx:layer.radiusPx*factor}:layer)}}));return {...project,clips,captions:{...project.captions,fontSize:project.captions.fontSize*factor},output:{...project.output,width:Math.max(64,Math.round(project.output.width*factor/2)*2),height:targetHeight},presentation:{...p,blur:p.blur*factor,padding:p.padding*factor,inset:p.inset*factor,radius:p.radius*factor,shadow:{...p.shadow,blur:p.shadow.blur*factor,distance:p.shadow.distance*factor}}};};
  const startExport=async(choice?:ExportChoice)=>{const snapshot=exportProject();if(!snapshot||recordingLock.current||busyRef.current||exportFor(job,exportReceipt,snapshot.id).job?.status==='running')return;pause();setBusy('Starting export');try{
    // On this computer when the dialog chose it (local-export.ts: the server's refusals and an app that cannot start it go to the server, saying why).
    const result:{job:EditorJob;notice?:string}=choice?.where==='computer'?await startOnComputer(snapshot,choice.destination,{request,bridge:studioLocalExport,pick:name=>studioLocalExport.pickDestination(name)}):await request<{job:EditorJob}>('/api/account/studio/export',{project:snapshot});
    if(result.notice)setExportNotice({tone:'warn',text:result.notice});setExportReceipt({jobId:result.job.id,projectId:snapshot.id,title:snapshot.title,width:snapshot.output.width,height:snapshot.output.height,fps:snapshot.output.fps,durationFrames:projectDuration(snapshot)});setJob(result.job);}catch(e){say(errorText(e),true);}finally{setBusy(null);}};
  const savePreset=async()=>{if(!project||!presetName.trim()||busy)return;setBusy('Saving preset');try{const result=await request<{preset:EditorPreset}>('/api/account/studio/presets',{name:presetName.trim(),presentation:project.presentation,cursor:project.cursor});setPresets(v=>[...v,result.preset]);setPresetName('');say('Appearance preset saved');}catch(e){say(errorText(e),true);}finally{setBusy(null);}};
  const aspect=deliveredOutput?deliveredOutput.width/deliveredOutput.height:project?project.output.width/project.output.height:16/10, previewWidth=Math.min(previewBox.width,previewBox.height*aspect);
  // The editor holds one export job whichever video is open: what it shows, and what waits on it, is this video's.
  const exportHere=project?exportFor(job,exportReceipt,project.id):{job:null,other:null};
  const running=exportHere.job?.status==='running';
  /** Beats picked on the Storyboard track or page; the inspector shows the beat (one) instead of a layer or clip. */
  const selectBeats=(ids:string[])=>{setSelectedBeatIds(ids);if(ids.length){setSelectedLayerId(null);setSelectedItems([]);clearWordSelection();setShowAppSettings(false);}};
  const openBeat=(beatId:string)=>{selectBeats([beatId]);setPage('storyboard');};
  const editAt=(at:number)=>{setPage('edit');seek(at);};
  const beatInspector=(beatId:string)=>project?<BeatInspector project={project} beatId={beatId} change={change} close={()=>setSelectedBeatIds([])} record={ids=>void recordBeats(ids)} recording={!!manual.active||manual.working} seek={seek} removeTake={sessionId=>void (async()=>{const p=currentRef.current;if(!p||!await saveAll())return;try{await request(`/api/account/studio/projects/${encodeURIComponent(p.id)}/takes/${encodeURIComponent(sessionId)}/undo`,{});await adoptAgentEdit();say('Removed that take: the edit is back to how it was before it');}catch(error){say(errorText(error),true);}})()} beforeServerEdit={saveAll} afterServerEdit={()=>void adoptAgentEdit()} onUseTake={(beatId,sessionId)=>void (async()=>{const p=currentRef.current;if(!p||!await saveAll())return;try{await request(`/api/account/studio/projects/${encodeURIComponent(p.id)}/beats/${encodeURIComponent(beatId)}/take`,{sessionId});await adoptAgentEdit();say('Switched the beat to that take');}catch(error){say(errorText(error),true);}})()}/>:null;
  const conflict=!!project&&(agentUpdate===project.id||!!saveError&&conflictPattern.test(saveError));
  const timelineMax=typeof window==='undefined'?500:Math.floor(window.innerHeight*.65);
  const motionPreviewHeader=tab==='motion'&&!showAppSettings&&!focusMode&&!busy&&!dialog;
  // The server has no Studio yet (its tables are not there): say so plainly; there is nothing to retry.
  if(notSetUp)return <div className="studio-recover"><h2>The Studio is not set up yet</h2><p>The Studio is not switched on for this app yet. Nothing is wrong with your account, and nothing was lost. Whoever runs Native Intelligence for your team can finish setting it up.</p></div>;
  // Projects and videos is a page beside the rail (ProjectChooser.tsx): drawn after the editor, which it covers, and the
  // editor (its header too) is inert meanwhile, so neither Tab nor assistive technology walks the covered controls.
  const chooserShown=(chooserOpen||!project&&!busy)&&!dialog&&!showAppSettings;
  return <main className="app with-rail" onDragEnter={e=>{if(showAppSettings||!externalDrag(e))return;e.preventDefault();fileDragDepth.current++;setFileDrag(true);}} onDragOver={e=>{if(showAppSettings){if(externalDrag(e))e.preventDefault();e.dataTransfer.dropEffect='none';return;}if(!externalDrag(e))return;e.preventDefault();e.dataTransfer.dropEffect=busy||dialog?'none':'copy';}} onDragLeave={e=>{if(showAppSettings||!externalDrag(e))return;e.preventDefault();fileDragDepth.current=Math.max(0,fileDragDepth.current-1);if(fileDragDepth.current===0)setFileDrag(false);}} onDrop={onFileDrop} onPointerDownCapture={e=>{if((e.target as HTMLElement).matches('input[type="range"]'))activeGroup.current=++groupCounter.current;}} onPointerUpCapture={()=>{if(!gestureHistory.current)activeGroup.current=null;}} onPointerCancelCapture={()=>{if(!gestureHistory.current)activeGroup.current=null;}}><AppRail page={page} hasProject={!!project} chooserOpen={chooserOpen||!project&&!busy} settingsOpen={showAppSettings} locked={presenter.active}
    openProjects={()=>leaveSettings(()=>setChooserOpen(open=>currentRef.current?!open:true))}
    openPage={id=>leaveSettings(()=>{setChooserOpen(false);setPage(id);})}/>
  <div className="app-main" inert={chooserShown||undefined} aria-hidden={chooserShown||undefined}><header className="topbar app-header"><div className="hdr-left">{showAppSettings?<div className="hdr-static"><strong>Apps setup</strong><span className="hdr-save">Reusable app connections</span></div>:project?<><TitleField title={project.title} disabled={presenter.active} rename={title=>change(p=>({...p,title}))}/><span className={`hdr-save${saveError?' error':''}`} role="status" title={saveError??undefined}>{saveError?<>Not saved{conflict?null:<button className="save-retry" onClick={()=>void saveAll()}>Retry</button>}</>:savingProject||dirty?'Saving…':<><Icon name="check" size={14}/>Saved</>}</span></>:<span className="hdr-save">{busy?'Opening…':'No video open'}</span>}</div>
  <div className="hdr-right header-actions" hidden={showAppSettings}>{project&&studioCan('costs')?<CostChip projectId={project.id}/>:null}<IconButton icon="undo" label="Undo (⌘Z)" onClick={undo} disabled={presenter.active||!history?.past.length}/><IconButton icon="redo" label="Redo (⇧⌘Z)" onClick={redo} disabled={presenter.active||!history?.future.length}/><div className="divider"/><button className="hdr-record" aria-label={manual.active?"Open the recording's controls":"Record a new take"} onClick={()=>{setDialog('record');void manual.refreshSessions();}} disabled={!manual.active&&(presenter.active||!!busy||running)} title={manual.active?'Open recording controls':'Record your screen, camera and microphone'}><Icon name="record"/><span className="record-label">{manual.active?'Recording…':manualFollowUp?'Recording ready':'Record'}</span></button><button className="primary" onClick={()=>setDialog('export')} disabled={presenter.active||!project||!!busy} title={running?'This video is exporting: open it to see its progress':undefined}><Icon name="export" size={16}/><span>{running&&exportHere.job?`Exporting ${Math.round(exportHere.job.progress*100)}%`:'Export'}</span></button><HeaderMenu items={[{label:'Save now',hint:'⌘S',disabled:!project||presenter.active,run:()=>void saveAll()},{label:'Appearance presets…',disabled:!project||presenter.active,run:()=>setDialog('presets')},{label:'Cursor',disabled:!project||presenter.active,run:showCursor},{label:'Projects and videos…',hint:'⌘O',disabled:presenter.active,run:()=>setChooserOpen(true)}]}/></div><div className="hdr-right header-actions" hidden={!showAppSettings}><button className="primary" onClick={()=>leaveSettings()}>Back to the video</button></div></header>
  {recoveryOffer&&!showAppSettings?<div className="app-banner" role="status"><Icon name="save"/><span>{recoveryOffer.same?<>You have unsaved changes{recoveryOffer.otherProject?<> to <b>“{recoveryOffer.draft.title}”</b></>:null} from {draftTime(recoveryOffer.savedAt)}.</>:<>You have unsaved changes{recoveryOffer.otherProject?<> to <b>“{recoveryOffer.draft.title}”</b></>:null} from {draftTime(recoveryOffer.savedAt)}, but the saved video changed since then (the agent may have edited it).</>}</span>{recoveryOffer.same?<><button className="primary" disabled={!!busy} onClick={()=>restoreRecovery(false)}>{recoveryOffer.otherProject?'Open and restore':'Restore'}</button><button className="subtle-button" onClick={discardRecovery}>Discard</button></>:<><button className="primary" onClick={discardRecovery}>Keep the saved version</button><button className="subtle-button" disabled={!!busy} onClick={()=>restoreRecovery(true)} title="Opens your unsaved edits as a separate video">Restore mine as a copy</button></>}</div>:null}
  {conflict&&project&&!showAppSettings?<div className="app-banner agent" role="status"><Icon name="agent"/><span><b>The agent updated this video</b> while you had unsaved changes here. Load its version, or keep yours (saving yours replaces its changes; they stay in the version history).</span><button className="primary" onClick={()=>void loadAgentVersion()}>Load its version</button><button className="subtle-button" onClick={()=>void keepLocalVersion()}>Keep mine</button></div>:null}
  {manual.active&&dialog!=='record'?<div className="rec-live-bar" role="status" aria-live="polite"><span className={`rec-live-dot ${manual.active.status}`}/>
    <strong>{manual.active.punch?.beatIds?'Beats':manual.active.punch?'Punch-in':'Recording'}</strong>
    <span className="rec-live-state">{manual.active.status==='preparing'?(manual.active.note??'Getting ready…'):manual.active.status==='countdown'?`Starting in ${manual.active.countdownRemaining??3}…`:manual.active.status==='recording'?clockLabel(manual.active.elapsedMs??0):manual.active.step==='Uploading'||manual.active.step==='Saving the recording'?'Saving…':`${plainStep(manual.active.step)} · ${Math.round(Math.max(0,Math.min(1,manual.active.progress??0))*100)}%`}</span>
    {['preparing','countdown','recording'].includes(manual.active.status)?<><button className="rec-live-stop" disabled={manual.working} onClick={()=>void manual.stop(manual.active!.id)}><span className="rec-square"/>Stop</button>
    <button className="rec-live-cancel" disabled={manual.working} onClick={()=>void manual.cancel(manual.active!.id)}>Cancel</button></>:<button className="rec-live-cancel" onClick={()=>setDialog('record')}>Show</button>}</div>:null}
  {manualFollowUp?<div className="run-follow-up manual-follow-up" role="status"><div><strong>{manualFollowUp.projectId?'Recording ready':manualFollowUp.partialAssetId?'Part of the recording was kept':'Recording needs attention'}</strong><span>{manualFollowUp.error??(manualFollowUp.projectId?(manualFollowUp.punch?'Open it to see the take in your edit.':'It opens as its own video when you are ready.'):manualFollowUp.partialAssetId?'The part that was recorded can become its own video.':'Open Record to review the session.')}</span></div>{manualFollowUp.projectId?<button className="subtle-button" disabled={!!busy||manual.working} onClick={()=>void openManualProject(manualFollowUp)}>Open recording</button>:manualFollowUp.partialAssetId?<button className="subtle-button" disabled={!!busy||manual.working} onClick={()=>void openManualPartial(manualFollowUp)}>Open partial</button>:<button className="subtle-button" onClick={()=>setDialog('record')}>Review</button>}<IconButton icon="close" label="Dismiss recording notice" onClick={()=>setManualFollowUp(null)}/></div>:null}
  <section className="app-setup-screen" hidden={!showAppSettings} aria-label="Apps setup"><div className="app-setup-intro"><span className="app-setup-kicker">Workspace setup</span><h1>Apps</h1><p>Connect an app once, then choose it for any video. Setup does not launch or record your app.</p></div><AppsPanel profiles={appProfiles} onChanged={refreshAppProfiles} onDirtyChange={setProfileDirty} registerEditor={registerProfileEditor} notify={say}/></section>
  {project?<>{page!=='edit'&&!showAppSettings?<div className="film-pages">{page==='project'?<CampaignPage project={project} openAd={openAd} editCast={()=>setPage('cast')} notify={say} refreshKey={`${project.id}:${projects.length}:${chooserOpen}`}/>:page==='overview'?<OverviewPage project={project} change={change} frame={frame} duration={duration} disabled={!!busy||!!dialog||presenter.active} openBeat={openBeat} editAt={editAt} goEdit={()=>setPage('edit')} savedKey={saved}/>
    :page==='storyboard'?<StoryboardPage project={project} change={change} frame={frame} duration={duration} disabled={!!busy||!!dialog||presenter.active} openBeat={openBeat} editAt={editAt} goEdit={()=>setPage('edit')} selected={selectedBeatIds} select={selectBeats} record={ids=>void recordBeats(ids)} recording={!!manual.active||manual.working} inspector={beatInspector} beforeServerEdit={saveAll} afterServerEdit={()=>void adoptAgentEdit()} openProject={id=>void openProject(id)} say={say} goCast={()=>setPage('cast')}/>
    :<CastPage project={project} change={change} openBeat={openBeat}/>}</div>:null}<div className="edit-body" hidden={showAppSettings||page!=='edit'}><div className="edit-main"><div className="workspace" ref={workspaceRef} hidden={showAppSettings||page!=='edit'}>{browserOpen?<BrowserPanel add={item=>void importFromBrowser(item)} disabled={!!busy||!!dialog||presenter.active} notify={say}/>:null}<section className="preview-region"><div className={motionPreviewHeader?"preview-toolbar motion-preview-toolbar":"preview-toolbar"}><button type="button" className={`preview-browser-toggle${browserOpen?' active':''}`} aria-pressed={browserOpen} aria-label="Browser" title={browserOpen?'Hide the Browser (⌥⌘B)':'Show the Browser (⌥⌘B)'} onClick={()=>setBrowserOpen(v=>!v)}><Icon name="browser"/></button><span hidden={motionPreviewHeader} className="preview-format"><FormatPicker project={project} change={change} disabled={!!busy}/><span className="format-meta">{formatPreset(project.delivery?.format)?.width??project.output.width} × {formatPreset(project.delivery?.format)?.height??project.output.height} · {project.output.fps} fps</span>{project.delivery?.format&&project.delivery.format!=='original'?<button className={`format-safe${safeZones?' on':''}`} aria-pressed={safeZones} title="Shade where the app draws its own buttons and captions" onClick={()=>setSafeZones(v=>!v)}>Safe zones</button>:null}</span><span className="quality-label" hidden={motionPreviewHeader}>Preview · Fit</span><div id="preview-motion-toolbar-slot" className="preview-motion-toolbar-slot"/><button type="button" className={`preview-inspector-toggle${inspectorOpen?' active':''}`} aria-pressed={inspectorOpen} aria-label="Inspector" title={inspectorOpen?'Hide the inspector (⌥⌘0)':'Show the inspector (⌥⌘0)'} onClick={()=>setInspectorOpen(v=>!v)}><Icon name="inspector"/></button></div><div className="preview-stage" ref={stage}><div className="preview-shell" style={{width:previewWidth,height:previewWidth/aspect}}><Player ref={player} component={EditorComposition} inputProps={playerInputProps} compositionWidth={deliveredOutput!.width} compositionHeight={deliveredOutput!.height} durationInFrames={duration} fps={project.output.fps} style={{width:'100%',height:'100%'}} renderLoading={()=> <div className="empty-preview">Loading recording…</div>} controls={false} clickToPlay={false} doubleClickToFullscreen={false} spaceKeyToPlayOrPause={false} moveToBeginningWhenEnded={false} numberOfSharedAudioTags={8} acknowledgeRemotionLicense/>{safeZones?<SafeZones project={project}/>:null}{['ready','countdown','recording'].includes(presenter.phase)?(()=>{const side=Math.min(project.output.width*.22,project.output.height*.28)*previewWidth/project.output.width,margin=.04*previewWidth,previewHeight=previewWidth/aspect;
  return <div className="live-presenter-bubble" style={{left:previewWidth-side-margin,top:previewHeight-side-.04*previewHeight,width:side,height:side,borderRadius:presenterRadius(preferredPresenterStyle(),side)}}>
    <video ref={presenter.videoRef} autoPlay muted playsInline aria-label="Live camera"/>{presenter.phase==='countdown'?<span>{presenter.countdown}</span>:presenter.phase==='recording'?<i aria-label="Recording"/>:null}</div>;})():null}<PreviewLayoutControls project={project} frame={frame} previewWidth={previewWidth} enabled={tab!=='presenter'&&tab!=='motion'&&!showAppSettings&&!focusMode&&!playing} disabled={!!busy||!!dialog||presenter.active} change={change} beginEdit={beginTimelineEdit} endEdit={endTimelineEdit}/><PreviewLayerControls project={project} frame={frame} previewWidth={previewWidth} enabled={tab!=='presenter'&&tab!=='motion'&&!showAppSettings&&!focusMode&&!playing} disabled={!!busy||!!dialog||presenter.active} selectedLayerId={selectedLayer?.id??null} select={id=>selectItems(id?[{kind:'layer',id}]:[])} change={change} beginEdit={beginTimelineEdit} endEdit={endTimelineEdit}/><PreviewPresenterControls project={project} frame={frame} previewWidth={previewWidth} enabled={tab==='presenter'&&!showAppSettings&&!focusMode} disabled={!!busy||!!dialog||presenter.active} change={change} beginEdit={beginTimelineEdit} endEdit={endTimelineEdit}/><PreviewMotionControls project={project} frame={frame} previewWidth={previewWidth} selectedLayerId={selectedMotionLayerId} enabled={tab==='motion'&&!showAppSettings&&!focusMode} disabled={!!busy||!!dialog} select={(clipId,layerId)=>{clearWordSelection();setSelectedIds([clipId]);setSelectedZoom(null);setSelectedMotionLayerId(layerId);setSelectedMotionTrackId(null);setFocusMode(false);setTab('motion');}} change={change} beginEdit={beginTimelineEdit} endEdit={endTimelineEdit}/>{focusMode&&zoom?<div className="focus-crosshair" role="button" aria-label="Choose zoom focus point" tabIndex={0} onKeyDown={e=>{if(e.key==='Escape')setFocusMode(false);}} onClick={e=>{const box=e.currentTarget.getBoundingClientRect(),a=project.assets.find(v=>v.id===clip?.assetId);if(!a)return;const padding=Math.min(project.presentation.padding+project.presentation.inset,Math.min(project.output.width,project.output.height)*.45),fit=Math.min((project.output.width-padding*2)/a.width!,(project.output.height-padding*2)/a.height!),w=a.width!*fit/project.output.width*box.width,h=a.height!*fit/project.output.height*box.height;changeZoom(z=>({...z,x:Math.max(0,Math.min(1,(e.clientX-box.left-(box.width-w)/2)/w)),y:Math.max(0,Math.min(1,(e.clientY-box.top-(box.height-h)/2)/h))}));setFocusMode(false);}}><span className="focus-hint">Click the point you want to zoom toward · Esc to cancel</span></div>:null}</div></div><div className="transport"><LiveTimecode fps={project.output.fps} frame={frame} playing={playing}/><div className="transport-controls"><IconButton icon="previous" label="Previous frame" onClick={()=>seek(frame-1)} disabled={presenter.active}/><IconButton className="play" icon={playing?'pause':'play'} label={playing?'Pause':'Play'} onClick={playPause} disabled={presenter.active}/><IconButton icon="next" label="Next frame" onClick={()=>seek(frame+1)} disabled={presenter.active}/></div><span className="timecode total">{secondsLabel(duration/project.output.fps)}</span><span className="speed-indicator" title="Source playback speed at playhead">{schedule.find(item=>frame>=item.startFrame&&frame<item.startFrame+item.durationFrames)?.clip.playbackRate??1}×</span></div></section><nav className="icon-rail" aria-label="Inspector tools">{railTabs.map(name=>{const showsTab=!selectedLayer&&!(selectedBeatIds.length===1&&project.storyboard?.beats.some(b=>b.id===selectedBeatIds[0])),active=railTabActive({open:inspectorOpen,tab},name,showsTab);return <IconButton key={name} icon={name} label={`${name.charAt(0).toUpperCase()+name.slice(1)} inspector`} className={active?'active':''} aria-pressed={active} onClick={()=>{const next=pressRailTab({open:inspectorOpen,tab},name,showsTab);if(!showsTab){selectItems([]);setSelectedBeatIds([]);}setTab(next.tab);setInspectorOpen(next.open);setFocusMode(false);}}/>;})}</nav><div className="project-library" hidden={!inspectorOpen}><div className="inspector-container">{selectedBeatIds.length===1&&project.storyboard?.beats.some(b=>b.id===selectedBeatIds[0])?beatInspector(selectedBeatIds[0]!):selectedLayer?<LayerInspector project={project} layerId={selectedLayer.id} change={change} close={()=>selectItems([])}/>:<Inspector tab={tab} project={project} presenter={presenter} retainedPresenterAssets={retainedPresenterAssets} onUseRetainedPresenter={useRetainedPresenter} startPresenterRecording={startPresenterRecording} clip={clip} zoom={zoom} motionSelection={{layerId:selectedMotionLayerId,trackId:selectedMotionTrackId}} selectMotionLayer={id=>{setSelectedMotionLayerId(id);setSelectedMotionTrackId(null);}} selectMotionTrack={setSelectedMotionTrackId} change={change} changeClip={changeClip} changeZoom={changeZoom} importMedia={beginImport} selectZoom={setSelectedZoom} removeZoom={()=>{if(zoom)changeClip(c=>({...c,zooms:c.zooms.filter(z=>z.id!==zoom.id)}));setSelectedZoom(null);}} focus={()=>{if(clip&&zoom){pause();const s=schedule.find(v=>v.clip.id===clip.id)!;seek(s.startFrame);setFocusMode(true);}}} reorder={offset=>{if(!clip)return;const at=project.clips.findIndex(c=>c.id===clip.id),target=project.clips[at+offset];if(target)reorder(clip.id,target.id);}} append={append} busy={!!busy} frame={frame} selectedClipIds={selectedIds} seek={seek} setBusy={setBusy} notify={say} newRecordingProject={newRecordingProject} selectedWordIds={wordSelection.ids} selectWord={selectWord} clearWordSelection={clearWordSelection} deleteWords={deleteWords} transcription={transcription} importedSource={importedSource}/>}</div></div></div><div className="editor-timeline-shell" hidden={showAppSettings||page!=='edit'} style={{'--timeline-height':`${timelineHeight}px`} as React.CSSProperties}><div className="timeline-resize" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" aria-valuenow={timelineHeight} aria-valuemin={150} aria-valuemax={timelineMax} tabIndex={0} onPointerDown={event=>{timelineResize.current={startY:event.clientY,height:timelineHeight};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}} onLostPointerCapture={()=>{timelineResize.current=null;}} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();setTimelineHeight(value=>Math.max(150,Math.min(timelineMax,value+(event.key==='ArrowUp'?12:-12))));}}}/><Timeline selectedBeatIds={selectedBeatIds} selectBeats={selectBeats} recordBeats={ids=>void recordBeats(ids)} recording={!!manual.active||manual.working} beforeServerEdit={saveAll} afterServerEdit={()=>void adoptAgentEdit()} selectedLayerId={selectedLayer?.id??null} selectedItems={selectedItems} selectItems={selectItems} playPause={playPause} selectLayer={id=>selectItems(id?[{kind:'layer',id}]:[])} notify={(text,error)=>say(text,error)} words={words} selectedWordIds={wordSelection.ids} selectWord={selectWord} deleteWords={deleteWords} cleanUp={cleanUp} automationView={automationView} toggleAutomation={()=>setAutomationView(v=>!v)} changeProject={change} punchIn={manual.active?undefined:beginPunch} project={project} frame={frame} selectedIds={selectedIds} selectedZoom={selectedZoom} selectedMotionLayerId={selectedMotionLayerId} selectedMotionTrackId={selectedMotionTrackId} selectMotion={(clipId,layerId,trackId)=>{clearWordSelection();setSelectedIds([clipId]);setSelectedZoom(null);setSelectedMotionLayerId(layerId);setSelectedMotionTrackId(trackId);setFocusMode(false);setTab('motion');}} editMotion={editTimelineMotion} editMotionLayer={editTimelineMotionLayer} onTyping={editTyping} setShot={(from,to,patch)=>change(p=>setShotRange(p,from,to,patch))} selectClip={(clipId,multiple)=>{clearWordSelection();setSelectedIds(ids=>multiple?(ids.includes(clipId)?ids.filter(v=>v!==clipId):[...ids,clipId]):[clipId]);setSelectedZoom(null);setSelectedMotionLayerId('primary');setSelectedMotionTrackId(null);setFocusMode(false);setTab('clip');}} selectZoom={(clipId,zoomId)=>{clearWordSelection();setSelectedIds([clipId]);setSelectedZoom(zoomId);setSelectedMotionTrackId(null);setTab('zoom');setFocusMode(false);}} seek={seek} split={split} remove={()=>{if(!wordSelection.ids.length)removeSelection();}} append={()=>beginImport('video')} reorder={reorder} addZoom={addZoom} editZoom={editTimelineZoom} editClip={editTimelineClip} beginEdit={beginTimelineEdit} endEdit={endTimelineEdit} showInspector={showInspector} disabled={!!busy||!!dialog||presenter.active}/></div></div></div></>:<div className="empty-preview">{!busy&&!projects.length?null:<><h2>Studio</h2><p>{busy??'The Studio could not open this video.'}</p>{!busy?<button className="subtle-button" onClick={()=>location.reload()}>Try again</button>:null}</>}</div>}
  {fileDrag&&!showAppSettings?<div className="file-drop-overlay" role="status"><div><strong>{busy||dialog?'Finish the current operation before importing':'Drop one recording or background image'}</strong><span>Video and audio join this video. PNG, JPEG and WebP images set the background.</span><small>One file at a time · Import does not make a paid speech request.</small></div></div>:null}
  <input ref={fileInput} className="file-input" type="file" aria-label="Import media" onChange={onImport}/>{busy?<div className="busy-status" role="status">{busy}…</div>:null}
  {dialog==='projects'?<Modal title="Videos" close={closeDialog}><div className="project-list">{projects.map(p=><button key={p.id} disabled={!!busy} onClick={()=>{if(p.id===project?.id){closeDialog();return;}openRecording(p.id);}}><span>{p.title}</span><small>{p.id===project?.id?'Open':'Open video'}</small></button>)}</div><p>Videos and their media are kept in this workspace.</p>{project?<button className="full-button" disabled={!!busy} onClick={()=>{if(dirty||profileDirty){setPendingProject('new');setDialog('navigate');return;}const next={...project,id:id(),title:'Untitled video'};load(next,null);setSaved('');closeDialog();}}>Make a copy of this video</button>:null}</Modal>:null}
  {dialog==='navigate'?<Modal title="Save your changes?" close={closeDialog}><p>You have unsaved changes. Save them before continuing, or continue without saving.</p><div className="modal-actions"><button disabled={!!busy} onClick={closeDialog}>Keep editing</button><button disabled={!!busy} onClick={()=>{const destination=pendingProject;profileEditor.current?.discard();if(destination==='action'){const action=pendingNavigation.current;pendingNavigation.current=null;setDialog(null);setPendingProject(null);if(action)void action();}else if(destination==='recording'&&pendingRecording){openRecordingProject(pendingRecording);}else if(destination==='new'&&project){const next={...project,id:id(),title:'Untitled video'};load(next,null);setSaved('');closeDialog();}else if(destination)void openProject(destination);}}>Continue without saving</button><button disabled={!!busy} className="primary" onClick={async()=>{const destination=pendingProject;if(!await saveAll())return;if(destination==='action'){const action=pendingNavigation.current;pendingNavigation.current=null;setDialog(null);setPendingProject(null);if(action)await action();}else if(destination==='recording'&&pendingRecording){openRecordingProject(pendingRecording);}else if(destination==='new'&&currentRef.current){load({...currentRef.current,id:id(),title:'Untitled video'},null);setSaved('');closeDialog();}else if(destination)await openProject(destination);}}>Save &amp; continue</button></div></Modal>:null}
  
  {dialog==='presets'&&project?<Modal title="Appearance presets" close={closeDialog}><div className="preset-list"><button className="preset-button clean" onClick={()=>{change(p=>({...p,presentation:defaultPresentation,cursor:{style:'none',size:24,clickFeedback:false}}));closeDialog();}}>Clean recording</button>{presets.map(p=><button key={p.id} className="preset-button" style={{background:p.presentation.background.kind==='gradient'?`linear-gradient(${p.presentation.background.angle}deg,${p.presentation.background.color},${p.presentation.background.color2})`:p.presentation.background.color}} onClick={()=>{const result=EditorProjectSchema.safeParse({...project,presentation:p.presentation,cursor:p.cursor});if(!result.success){say('This preset uses a background image missing from this video. Import that image first.',true);return;}change(v=>({...v,presentation:p.presentation,cursor:p.cursor}));closeDialog();}}>{p.name}</button>)}</div><label className="field"><span className="field-label">Save current appearance as a preset</span><input aria-label="Preset name" value={presetName} maxLength={80} placeholder="e.g. Soft violet" onChange={e=>setPresetName(e.target.value)}/></label><button className="full-button" disabled={!presetName.trim()||!!busy} onClick={()=>void savePreset()}>Save appearance preset</button></Modal>:null}
  {dialog==='new-project'?<Modal title="New video" close={closeDialog}><NewProjectPanel close={closeDialog} created={(id,brief)=>{closeDialog();setProjects(list=>[{id,title:''},...list]);if(brief)setAgentBrief({projectId:id,text:brief});navigate(async()=>{await openProject(id);});}}/></Modal>:null}
  {dialog==='record'?<RecordDialog title={punch?.beatIds?"Record into beats":punch?"Punch in":"New recording"} close={()=>{setPunch(null);if(!manual.active)manual.clearShare();closeDialog();}} cameraInputs={project?.storyboard?(()=>{const c=project.storyboard!.inputs?.cameras??{};return{main:c.A?.deviceId??null,extras:(['B','C','D'] as const).flatMap(k=>c[k]?[c[k]!.deviceId]:[])};})():null}
    setCameraInputs={project?.storyboard?(main)=>change(p=>{if(!p.storyboard)return p;const cameras:Record<string,{deviceId:string;name:string}>={...(p.storyboard.inputs?.cameras??{})};if(main)cameras.A={deviceId:main.id,name:main.name};else delete cameras.A;
      return{...p,storyboard:{...p.storyboard,inputs:{...(p.storyboard.inputs??{}),cameras}}};}):undefined} punch={punch} recording={manual} start={async options=>{await startManualRecording(options);}} open={session=>void openManualProject(session)}/>:null}
  {dialog==='export'&&project?<ExportDialog project={project} job={exportHere.job} otherExport={exportHere.other} notice={exportNotice} receipt={exportReceipt} size={exportSize} setSize={setExportSize} output={exportProject()?.output??project.output} durationFrames={duration} busy={!!busy||running} start={choice=>void startExport(choice)} moveToServer={async jobId=>{try{const next=await finishOnServer(jobId,request,studioLocalExport);if(next.moved)setExportReceipt(r=>r&&r.jobId===jobId?{...r,jobId:next.job.id}:r);setJob(next.job);return null;}catch(e){return errorText(e);}}} continueHere={async (jobId,suggestedName)=>{try{await continueOnComputer(jobId,suggestedName,{request,bridge:studioLocalExport,pick:name=>studioLocalExport.pickDestination(name)});return null;}catch(e){return studioRefusal(e).message;}}} cancel={async()=>{const current=exportHere.job;if(!current)return false;if(current.where==='computer')void studioLocalExport.cancel(current.id).catch(()=>undefined);try{const v=await request<{job:EditorJob}>(`/api/account/studio/jobs/${current.id}/cancel`,{});setJob(v.job);return true;}catch{return false;}}} close={()=>{setExportNotice(null);closeDialog();}} beforeServerEdit={saveAll} openVideo={id=>{closeDialog();void openProject(id);}} say={say}/>:null}
  </div>
  {chooserShown?<ProjectChooser currentProjectId={project?.id??null} currentTitle={project?.title} refreshKey={`${projects.length}:${project?.id}:${saved.length}`} disabled={!!busy||presenter.active} canClose={!!project} close={()=>setChooserOpen(false)}
    onProject={projectId=>navigate(async()=>{if(await openProject(projectId))setChooserOpen(false);})} onRecord={()=>{setChooserOpen(false);setPunch(null);setDialog('record');void manual.refreshSessions();}} onNew={()=>{setChooserOpen(false);setDialog('new-project');}} onRenameCurrent={title=>change(p=>({...p,title}))}
    onDeleted={(deletedId,remaining)=>{setProjects(list=>list.filter(item=>item.id!==deletedId));if(deletedId===currentRef.current?.id){savedRef.current=JSON.stringify(currentRef.current);setSaved(savedRef.current);try{localStorage.removeItem(draftKey);}catch{}if(remaining[0])void openProject(remaining[0].id);else{pause();setHistory(null);setSaved('');savedRef.current='';}}}}/>:null}
  </main>;
}

/** The transport's timecode: live during playback without re-rendering the editor. */
function LiveTimecode({ fps, frame, playing }: { fps: number; frame: number; playing: boolean }) {
  const live = useLiveFrame();
  return <span className="timecode">{secondsLabel((playing ? live : frame) / fps)}</span>;
}

/** The film's name in the header: click to rename, Enter saves, Esc cancels. */
function TitleField({ title, rename, disabled }: { title: string; rename: (title: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { const next = draft?.trim(); setDraft(null); if (next && next !== title) rename(next); };
  if (draft !== null) return <input className="hdr-title-input" aria-label="Video name" autoFocus value={draft} maxLength={250} onFocus={e => e.currentTarget.select()} onChange={e => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); } }} />;
  return <button className="hdr-title" title={`${title} · click to rename`} aria-label={`Video name: ${title}. Rename`} disabled={disabled} onClick={() => setDraft(title)}><span>{title}</span></button>;
}

/** Less-used commands, one click away: save now, appearance presets, apps setup, projects. */
function HeaderMenu({ items }: { items: { label: string; hint?: string; disabled?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); root.current?.querySelector<HTMLElement>('.hdr-more')?.focus(); } };
    document.addEventListener('pointerdown', outside); studioKeys.addEventListener('keydown', key); return () => { document.removeEventListener('pointerdown', outside); studioKeys.removeEventListener('keydown', key); }; }, [open]);
  return <div className="hdr-menu-wrap" ref={root}><button className="hdr-more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name="more"/></button>
    {open ? <div className="hdr-menu" role="menu">{items.map(item => <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => { setOpen(false); item.run(); }}><span>{item.label}</span>{item.hint ? <kbd>{item.hint}</kbd> : null}</button>)}</div> : null}</div>;
}
