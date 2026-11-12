import { studioPortal, studioKeys, studioCan, fitMenu } from '../studio-env';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorProject, EditorZoom, MotionLayer, MotionTrack } from '@/lib/studio/engine/contracts';
import { scheduleProject, projectDuration, splitClip, type ScheduledClip } from '@/lib/studio/engine/timeline';
import { clipTrim, editZoom as shiftedZoom, keyboardMarkers, zoomBounds, type ZoomEditMode } from '@/lib/studio/engine/interaction';
import { IconButton, Waveform } from './controls';
import { Icon } from './icons';
import { emptyTimelineFrame } from './timeline-input';
import { cleanupWords, type TranscriptRow } from '@/lib/studio/engine/transcript';
import { uncertainPointGroups } from './word-selection';
import { MotionCurveLane } from './MotionCurveLane';
import { typingSuggestions } from '@/lib/studio/engine/speed';
import { motionPropertyLabels } from './motion-labels';
import { timelineCurveRows } from './timeline-tracks';
import { ShotLanes } from './ShotLanes';
import { AutomationOverlay, automationTools, paramTone, type AutomationTool } from './AutomationOverlay';
import { TrackHeads, TRACK_HEIGHT, defaultTrackParams, type TrackParams, type TrackHeights } from './TrackHeads';
import { LayerLanes } from './LayerLanes';
import { AudioLanes } from './AudioLanes';
import { itemKey, marqueeItems, pickItems, snapDelta, splitItem, timelineSpans, type PickMode, type TimelineItem } from '@/lib/studio/engine/timeline-selection';
import { LayoutLane } from './LayoutLane';
import { StoryboardHead, StoryboardLane } from './Storyboard';
import { SoundMenu } from './SoundMenu';
import { MotionCheck, ReviewVideo } from './MotionCheck';
import { ComponentsGallery } from './ComponentsGallery';
import { useLiveFrame } from './live-frame';
import { lanePoints, paramInfo, setLanePoints, transitionKinds, type AutomationParam, type TransitionKind } from '@/lib/studio/engine/automation';
import { applyOps, type OpCall } from '@/lib/studio/engine/ops';
import { layerKindInfo, type LayerKind } from '@/lib/studio/engine/layers';
import { availableShotSources, clipView, layoutPresetOf, layoutPresets, setLayoutForClips } from '@/lib/studio/engine/shots';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { removeAudioSegment } from '@/lib/studio/engine/audio-segments';
import type { ClipView } from '@/lib/studio/engine/contracts';

export const secondsLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
type Gesture = {pointerId:number; target:HTMLElement; x:number; width:number; duration:number; scheduled:ScheduledClip} & ({kind:'zoom'; zoom:EditorZoom; mode:ZoomEditMode}|{kind:'clip'; mode:'start'|'end'}|{kind:'layer'; layer:MotionLayer; mode:'move'|'start'|'end'});
/** A new id for the piece a cut makes. */
const cutId=()=>`cut${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
export function Timeline({selectedBeatIds=[], selectBeats, recordBeats, recording=false, project, frame, selectedIds, selectedZoom, selectClip, selectZoom, seek, split, remove, append, reorder, addZoom, editZoom, editClip, beginEdit, endEdit, disabled, words, selectedWordIds, selectWord, deleteWords, selectedMotionLayerId, selectedMotionTrackId, selectMotion, editMotion, editMotionLayer, onTyping, setShot, cleanUp, punchIn, automationView, toggleAutomation, beforeServerEdit, afterServerEdit, changeProject, selectedLayerId=null, selectLayer, notify, selectedItems=[], selectItems, playPause}: {
  /** Multi-selection of audio segments and layers (Delete removes them all; dragging one moves them together). */
  selectedItems?: TimelineItem[]; selectItems?: (items: TimelineItem[]) => void; playPause?: () => void;
  selectedLayerId?: string|null; selectLayer?: (id: string|null) => void; notify?: (text: string, error?: boolean) => void;
  cleanUp?: () => void;
  /** Record a new take over the selection, or insert one at the playhead. */
  punchIn?: () => void;
  /** Automation view (A): timeline-wide zoom/pan curves. */
  automationView?: boolean; toggleAutomation?: () => void; changeProject?: (fn: (p: EditorProject) => EditorProject) => void;
  /** Server-side edits (product components): save first, adopt the saved project after. */
  beforeServerEdit?: () => Promise<boolean>; afterServerEdit?: () => void;
  words:TranscriptRow[]; selectedWordIds:string[]; selectWord:(id:string,multiple:boolean,range:boolean)=>void; deleteWords:()=>void;
  project: EditorProject; frame: number; selectedIds: string[]; selectedZoom: string | null; selectClip: (id: string, multiple: boolean) => void;
  selectZoom: (clipId: string, id: string) => void; seek: (frame: number) => void; split: () => void; remove: () => void; append: () => void;
  reorder: (id: string, target: string) => void; addZoom: () => void;
  editZoom:(clipId:string,zoom:EditorZoom)=>void; editClip:(clipId:string,start:number,end:number)=>void; beginEdit:()=>void; endEdit:(cancel:boolean)=>void; disabled:boolean;
  selectedMotionLayerId:string;selectedMotionTrackId:string|null;selectMotion:(clipId:string,layerId:string,trackId:string|null)=>void;editMotion:(clipId:string,track:MotionTrack)=>void;editMotionLayer:(clipId:string,layerId:string,mode:'move'|'start'|'end',delta:number)=>void;
  onTyping?:(action:'apply'|'all'|'reset'|'remove',id:string,rate:number)=>void;
  setShot?:(from:number,to:number,patch:Partial<ClipView>)=>void;
  /** Storyboard: selected beats, and recording into them. */
  selectedBeatIds?:string[]; selectBeats?:(ids:string[])=>void; recordBeats?:(ids:string[])=>void; recording?:boolean;
}) {
  const schedule = scheduleProject(project), duration = projectDuration(project), fps = project.output.fps;
  const motionClip=selectedIds.length===1?schedule.find(item=>item.clip.id===selectedIds[0]):undefined;
  const motionTarget=motionClip?.clip.motion.layers.some(layer=>layer.id===selectedMotionLayerId)?selectedMotionLayerId:'primary';
  const motionTrack=motionClip?.clip.motion.tracks.find(track=>track.id===selectedMotionTrackId&&track.target===motionTarget);
  const [showEmptyTracks,setShowEmptyTracks]=useState(false),[showLayers,setShowLayers]=useState(true),[allCurves,setAllCurves]=useState(false);
  const curveRows=timelineCurveRows(schedule,selectedIds,selectedMotionLayerId,allCurves);
  const layerCount=schedule.reduce((count,item)=>count+item.clip.motion.layers.length,0),curveCount=schedule.reduce((count,item)=>count+item.clip.motion.tracks.length,0),hasZooms=schedule.some(item=>item.clip.zooms.length>0);
  const [density,setDensity]=useState(1),scroll=useRef<HTMLDivElement>(null),scrollStart=useRef(0);
  const zoomPending=useRef(false);
  useLayoutEffect(()=>{zoomPending.current=false;if(scroll.current)scroll.current.scrollLeft=scrollStart.current*density;},[density]);
  // Zoom like a DAW: pinch or ⌘/Ctrl+scroll zooms time around the pointer; ⌥+pinch or ⌥+scroll makes lanes taller or shorter.
  const [laneScale,setLaneScale]=useState(1),densityRef=useRef(density),laneScaleRef=useRef(laneScale);densityRef.current=density;laneScaleRef.current=laneScale;
  const zoomTime=useCallback((next:number,clientX:number)=>{const el=scroll.current;if(!el)return;const old=densityRef.current,value=Math.max(1,Math.min(64,next));if(Math.abs(value-old)<1e-3)return;
    const x=clientX-el.getBoundingClientRect().left,left=zoomPending.current?scrollStart.current*old:el.scrollLeft;scrollStart.current=Math.max(0,(left+x)/old-x/value);zoomPending.current=true;densityRef.current=value;setDensity(value);},[]);
  const zoomLanes=useCallback((next:number)=>{const value=Math.max(.6,Math.min(5,next));laneScaleRef.current=value;setLaneScale(value);},[]);
  useEffect(()=>{const el=scroll.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{if(!(e.ctrlKey||e.metaKey||e.altKey))return;e.preventDefault();
      const unit=e.deltaMode===1?16:1,dx=Math.max(-60,Math.min(60,e.deltaX*unit)),dy=Math.max(-60,Math.min(60,e.deltaY*unit));
      // Pinch (ctrl) zooms time. ⌘+swipe follows the gesture: left/right zooms time, up/down zooms lane height.
      if(e.ctrlKey&&!e.metaKey){zoomTime(densityRef.current*Math.exp(-dy*.012),e.clientX);return;}
      if(e.altKey&&!e.metaKey){zoomLanes(laneScaleRef.current*Math.exp(-dy*.006));return;}
      const horizontal=Math.abs(dx)>Math.abs(dy)||e.shiftKey;
      if(horizontal)zoomTime(densityRef.current*Math.exp(-(e.shiftKey&&!dx?dy:dx)*.008),e.clientX);else zoomLanes(laneScaleRef.current*Math.exp(-dy*.006));};
    // ⌘←/⌘→ zoom time and ⌘↑/⌘↓ zoom lanes, like Logic.
    const key=(e:Event)=>{const {axis,direction}=(e as CustomEvent<{axis:'time'|'lanes';direction:1|-1}>).detail,box=el.getBoundingClientRect();
      if(axis==='time')zoomTime(densityRef.current*(direction>0?1.5:1/1.5),box.left+box.width/2);else zoomLanes(laneScaleRef.current*(direction>0?1.25:.8));};
    window.addEventListener('ni-studio-timeline-zoom',key);
    // Safari/WebKit (the desktop app) reports trackpad pinches as gesture events instead of ctrl+wheel.
    let base=1,baseLanes=1;type Gesture=Event&{scale:number;clientX:number;altKey:boolean};
    const start=(e:Event)=>{e.preventDefault();base=densityRef.current;baseLanes=laneScaleRef.current;};
    const change=(e:Event)=>{const g=e as Gesture;e.preventDefault();if(g.altKey)zoomLanes(baseLanes*g.scale);else zoomTime(base*g.scale,g.clientX);};
    el.addEventListener('wheel',wheel,{passive:false});el.addEventListener('gesturestart',start);el.addEventListener('gesturechange',change);
    return()=>{window.removeEventListener('ni-studio-timeline-zoom',key);el.removeEventListener('wheel',wheel);el.removeEventListener('gesturestart',start);el.removeEventListener('gesturechange',change);};},[zoomTime,zoomLanes]);
  const cleanupIds=useMemo(()=>new Set(cleanupWords(words).map(w=>w.id)),[words]),wordDrag=useRef(false) as React.MutableRefObject<boolean>&{last?:string};
  // Words read like labels on a map: each is written out where it fits, and the rest collapse to a dot until you zoom in.
  const wordLane=useRef<HTMLDivElement>(null),[wordLaneWidth,setWordLaneWidth]=useState(0);
  useLayoutEffect(()=>{const lane=wordLane.current;if(!lane)return;const observer=new ResizeObserver(()=>setWordLaneWidth(lane.clientWidth));observer.observe(lane);setWordLaneWidth(lane.clientWidth);return()=>observer.disconnect();},[words.length>0]);
  const wordLayout=useMemo(()=>{const reliable=words.filter(row=>row.timingReliable),scale=wordLaneWidth/Math.max(1,duration),shown=new Set<string>(),span=new Map<string,number>();
    const lastRight:Record<string,number>={};
    reliable.forEach((row,index)=>{const next=reliable.slice(index+1).find(other=>other.sourceKind===row.sourceKind);span.set(row.id,Math.max(row.endFrame,Math.min(next?.startFrame??row.endFrame,row.endFrame+duration))-row.startFrame);
      const left=row.startFrame*scale,width=(project.captionCorrections[row.wordId]??row.text).length*6.6*Math.min(1.7,Math.max(1,laneScale))+8,lane=row.sourceKind;
      if(left>=(lastRight[lane]??-Infinity)+3){shown.add(row.id);lastRight[lane]=left+width;}});
    return{reliable,shown,span};},[words,wordLaneWidth,duration,project.captionCorrections,laneScale]);

  useEffect(()=>{const up=()=>{wordDrag.current=false;};window.addEventListener('pointerup',up);return()=>window.removeEventListener('pointerup',up);},[]);
  const selectedWords=words.filter(w=>selectedWordIds.includes(w.id)),uncertain=selectedWords.some(w=>!w.timingReliable);
  const points=useMemo(()=>[...uncertainPointGroups(words).values()],[words]);
  const hasClipWords=words.some(w=>w.sourceKind==='clip'),mixedWords=hasClipWords&&words.some(w=>w.sourceKind==='voiceover');
  const wordHeight=mixedWords?72:44;
  const markers = useMemo(()=>keyboardMarkers(project),[project]);
  const suggestions=useMemo(()=>typingSuggestions(project),[project]);
  const [typingPopup,setTypingPopup]=useState<{suggestionId:string;clipId:string;x:number;y:number}|null>(null),[typingRate,setTypingRate]=useState(2);
  const activeSuggestion=typingPopup?suggestions.find(item=>item.id===typingPopup.suggestionId):undefined;
  const activeTypingClip=typingPopup?project.clips.find(item=>item.id===typingPopup.clipId):undefined;
  useEffect(()=>{setTypingPopup(null);},[project.id]);
  useEffect(()=>{if(!typingPopup)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setTypingPopup(null);};const outside=(event:PointerEvent)=>{if(!(event.target as HTMLElement).closest('.typing-popover,.keyboard-marker'))setTypingPopup(null);};studioKeys.addEventListener('keydown',close);window.addEventListener('pointerdown',outside);return()=>{studioKeys.removeEventListener('keydown',close);window.removeEventListener('pointerdown',outside);};},[typingPopup]);
  const hasKeyboardTrace = project.clips.some(c=>project.assets.find(a=>a.id===c.assetId)?.trace);
  const area = useRef<HTMLDivElement>(null), drag = useRef<string | null>(null), gesture=useRef<Gesture|null>(null);
  const finish=useCallback((cancel:boolean)=>{const g=gesture.current;if(!g)return;gesture.current=null;endEdit(cancel);if(g.target.hasPointerCapture(g.pointerId))g.target.releasePointerCapture(g.pointerId);},[endEdit]);
  useEffect(()=>{const cancel=()=>finish(true);const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&gesture.current){e.preventDefault();e.stopPropagation();cancel();}};window.addEventListener('blur',cancel);studioKeys.addEventListener('keydown',escape,true);return()=>{window.removeEventListener('blur',cancel);studioKeys.removeEventListener('keydown',escape,true);cancel();};},[finish]);
  useEffect(()=>{finish(true);},[project.id,finish]);
  useEffect(()=>{if(disabled)finish(true);},[disabled,finish]);
  // Track headers sit in a fixed column on the left; lanes (and every frame calculation) start after it.
  const HEAD=0; // headers live in their own fixed column, outside the scrolling lanes
  const laneRect=()=>{const b=area.current?.getBoundingClientRect();return b?{left:b.left+HEAD,width:Math.max(1,b.width-HEAD)}:null;};
  const [trackParams,setTrackParams]=useState<TrackParams>(defaultTrackParams);
  const [tool,setTool]=useState<AutomationTool>('pointer'),[menu,setMenu]=useState<'add'|'transition'|'layout'|null>(null);
  useEffect(()=>{if(!menu)return;const close=(event:PointerEvent)=>{if(!(event.target as HTMLElement).closest('.tl-menu'))setMenu(null);};window.addEventListener('pointerdown',close);return()=>window.removeEventListener('pointerdown',close);},[menu]);
  // Automation tools from the keyboard while Automation is on: V pointer, P pencil, L line, E eraser.
  useEffect(()=>{if(!automationView)return;const key=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;if(event.metaKey||event.ctrlKey||event.altKey||target.closest('input,textarea,select,[contenteditable=true]'))return;
    const picked=automationTools.find(item=>item.key.toLowerCase()===event.key.toLowerCase());if(picked){event.preventDefault();setTool(picked.id);}};studioKeys.addEventListener('keydown',key);return()=>studioKeys.removeEventListener('keydown',key);},[automationView]);
  /** Run editing commands (the same ones the assistant uses) at the playhead. */
  const run=(calls:OpCall[],message:string)=>{if(!changeProject)return null;try{const {project:next,results}=applyOps(project,calls);changeProject(()=>next);notify?.(message);return results;}catch(error){notify?.(error instanceof Error?error.message:String(error),true);return null;}};
  const at=+(frame/fps).toFixed(3);
  const addLayer=(kind:LayerKind|'kinetic')=>{setMenu(null);
    const call:OpCall|null=kind==='text'?{op:'add_text',args:{text:'Your headline',at,duration:3,look:'title'}}:kind==='kinetic'?{op:'add_kinetic_captions',args:{}}
      :kind==='arrow'?{op:'add_arrow',args:{x:0.6,y:0.55,at,duration:2.5}}
      :kind==='notification'?{op:'add_notification',args:{app:'Messages',title:'New message',text:'This is amazing!',icon:'💬',at,duration:3}}
      :kind==='card'?{op:'add_card',args:{text:'We’re looking to hire you! 💼',icon:'🙂',at,duration:3}}
      :kind==='chips'?{op:'add_chips',args:{items:['First step','Second step','Third step'],at,duration:3}}
      :kind==='background'?{op:'add_background',args:{fill:'mesh',at,duration:2}}
      :kind==='waveform'?{op:'add_waveform',args:{at,duration:3}}
      :kind==='icons'?{op:'add_icons',args:{items:['note','note','note','note'],at,duration:3}}
      :kind==='ring'?{op:'add_ring',args:{at,duration:3}}
      :kind==='particles'?{op:'add_particles',args:{at,duration:4,forms:[{at:0,shape:'scatter',x:0.5,y:0.5,w:0.4,h:0.2,opacity:0},{at:0.1,shape:'line',x:0.5,y:0.5,w:0.5,jitter:0.006,stagger:0.3},{at:1.2,shape:'bars',x:0.5,y:0.5,w:0.5,h:0.16,barWidth:0.006,stagger:0.35},{at:2.6,shape:'ring',x:0.5,y:0.5,h:0.3,spin:0.4,order:'angle',stagger:0.4,duration:0.9}]}}
      :kind==='image'?null:{op:'add_callout',args:{kind,x:0.5,y:0.5,width:kind==='highlight'?0.32:0.36,height:kind==='highlight'?0.08:0.28,at,duration:2.5}};
    if(!call){notify?.('Ask the assistant to add an image layer (add_image) — it needs a picture from your media',true);return;}
    const results=run([call],kind==='kinetic'?'Word-by-word captions added from the transcript':`${layerKindInfo[kind].label} added at the playhead · edit it in the inspector`);
    const added=results?.[0] as {id?:string;ids?:string[]}|undefined;if(added?.id)selectLayer?.(added.id);};
  const addTransitionHere=(kind:TransitionKind)=>{setMenu(null);
    if(run([{op:'add_transition',args:{at,kind}}],`${transitionKinds.find(item=>item.id===kind)!.label} added at the playhead · it's editable automation on the picture`)){
      const shown:AutomationParam=kind==='zoom-punch'?'zoom':kind.startsWith('whip-left')||kind==='whip-right'?'shiftX':kind.startsWith('whip')?'shiftY':kind==='blur'?'blur':kind==='spin'?'rotate':'opacity';
      setTrackParams(current=>({...current,video:shown}));}};
  const pictureParam=(trackParams.video??'zoom') as AutomationParam|'off',audioParam=trackParams.audio??'volume';
  // Layouts act on the selected clips, or on the clip under the playhead.
  const layoutTargets=selectedIds.length?selectedIds:[schedule.find(s=>frame>=s.startFrame&&frame<s.startFrame+s.durationFrames)?.clip.id].filter((id):id is string=>!!id);
  const layoutSources=availableShotSources(project),layoutClip=project.clips.find(c=>c.id===layoutTargets[0]),currentLayout=layoutClip?layoutPresetOf(clipView(layoutClip)):'single';
  const applyLayout=(presetId:string)=>{setMenu(null);if(!changeProject||!layoutTargets.length)return;
    try{const next=setLayoutForClips(project,layoutTargets,presetId);changeProject(()=>next);notify?.(`${layoutPresets.find(item=>item.id===presetId)!.label} · pick sources and order in the inspector`);}
    catch(error){notify?.(error instanceof Error?error.message:String(error),true);}};
  /** Every track shares one height; a track the person dragged taller keeps its own (remembered on this computer). */
  const [trackHeights,setTrackHeights]=useState<TrackHeights>(()=>{try{return JSON.parse(localStorage.getItem('ni:studio:trackHeights')??'{}') as TrackHeights;}catch{return{};}});
  const setTrackHeight=useCallback((key:string,height:number|null)=>setTrackHeights(current=>{const next={...current};if(height===null)delete next[key];else next[key]=Math.round(height);try{localStorage.setItem('ni:studio:trackHeights',JSON.stringify(next));}catch{/* per-viewer convenience only */}return next;}),[]);
  const trackHeightCss=Object.entries(trackHeights).map(([key,h])=>`.timeline-lanes [data-head="${key.replace(/["\\]/g,'')}"]{height:calc(${h}px*var(--lane-scale,1))!important}`).join('\n');
  const start=(e:React.PointerEvent<HTMLElement>,scheduled:ScheduledClip,mode:ZoomEditMode,zoom?:EditorZoom)=>{
    if(disabled||e.button!==0||gesture.current)return;e.preventDefault();e.stopPropagation();const box=laneRect();if(!box?.width)return;
    if(zoom)selectZoom(scheduled.clip.id,zoom.id);else selectClip(scheduled.clip.id,false);
    e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);beginEdit();
    const base={pointerId:e.pointerId,target:e.currentTarget,x:e.clientX,width:box.width,duration,scheduled};
    gesture.current=zoom?{...base,kind:'zoom',zoom,mode}:{...base,kind:'clip',mode:mode as 'start'|'end'};
  };
  const startLayer=(e:React.PointerEvent<HTMLElement>,scheduled:ScheduledClip,layer:MotionLayer,mode:'move'|'start'|'end')=>{if(disabled||e.button!==0||gesture.current)return;e.preventDefault();e.stopPropagation();const box=laneRect();if(!box?.width)return;selectMotion(scheduled.clip.id,layer.id,null);e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);beginEdit();gesture.current={pointerId:e.pointerId,target:e.currentTarget,x:e.clientX,width:box.width,duration,scheduled,kind:'layer',layer,mode};};
  const move=(e:React.PointerEvent<HTMLElement>)=>{const g=gesture.current;if(!g||g.pointerId!==e.pointerId)return;e.preventDefault();e.stopPropagation();const delta=Math.round((e.clientX-g.x)/g.width*g.duration);
    if(g.kind==='zoom')editZoom(g.scheduled.clip.id,shiftedZoom(g.zoom,g.mode,delta,zoomBounds(g.zoom,g.scheduled.clip.zooms,g.scheduled.durationFrames)));
    else if(g.kind==='layer')editMotionLayer(g.scheduled.clip.id,g.layer.id,g.mode,delta);
    else {const [start,end]=clipTrim(g.scheduled.clip,g.scheduled.asset,fps,g.mode,delta);editClip(g.scheduled.clip.id,start,end);}
  };
  const pointerHandlers={onPointerMove:move,onPointerUp:(e:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId!==e.pointerId)return;move(e);finish(false);},onPointerCancel:(e:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===e.pointerId)finish(true);},onLostPointerCapture:(e:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===e.pointerId)finish(true);}};
  const nudge=(e:React.KeyboardEvent,scheduled:ScheduledClip,mode:ZoomEditMode,zoom?:EditorZoom)=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();e.stopPropagation();if(disabled||gesture.current)return;const delta=(e.key==='ArrowRight'?1:-1)*(e.shiftKey?10:1)*(zoom?1:Math.max(1,fps/scheduled.asset.sourceFps!));if(zoom){selectZoom(scheduled.clip.id,zoom.id);editZoom(scheduled.clip.id,shiftedZoom(zoom,mode,delta,zoomBounds(zoom,scheduled.clip.zooms,scheduled.durationFrames)));}else{const [start,end]=clipTrim(scheduled.clip,scheduled.asset,fps,mode as 'start'|'end',delta);selectClip(scheduled.clip.id,false);editClip(scheduled.clip.id,start,end);}};
  const nudgeLayer=(event:React.KeyboardEvent,scheduled:ScheduledClip,layer:MotionLayer,mode:'move'|'start'|'end')=>{if(disabled||gesture.current||event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();event.stopPropagation();selectMotion(scheduled.clip.id,layer.id,null);editMotionLayer(scheduled.clip.id,layer.id,mode,(event.key==='ArrowRight'?1:-1)*(event.shiftKey?10:1));};
  // Edit tools (NLE style): Select (V), Hand (H, or hold Space), Blade (B/C) and Zoom (Z); S toggles snapping.
  const [editTool,setEditTool]=useState<EditTool>('select'),[snapOn,setSnapOn]=useState(true),[spaceHeld,setSpaceHeld]=useState(false),[panning,setPanning]=useState(false);
  const [marquee,setMarquee]=useState<{x0:number;y0:number;x1:number;y1:number}|null>(null),[bladeX,setBladeX]=useState<number|null>(null);
  const space=useRef({down:false,panned:false}),hovering=useRef(false);
  const pick=(item:TimelineItem,mode:PickMode)=>selectItems?.(pickItems(project,selectedItems,item,mode));
  /** Snapping: a dragged edge within 8 px of the playhead, a clip boundary or another item's edge lands on it. */
  const snapper=(edges:number[],delta:number,exclude:string[])=>{if(!snapOn)return delta;const width=area.current?.getBoundingClientRect().width??0;if(!width)return delta;const skip=new Set(exclude);
    const targets=[0,frame,...schedule.flatMap(s=>[s.startFrame,s.startFrame+s.durationFrames]),...timelineSpans(project).filter(span=>!skip.has(span.key)).flatMap(span=>[span.startFrame,span.endFrame])];
    return snapDelta(edges,targets,delta,8/width*duration);};
  const stateRef=useRef({selectedItems,selectItems,project,playPause,zoomTime,density});stateRef.current={selectedItems,selectItems,project,playPause,zoomTime,density};
  useEffect(()=>{const typing=(e:KeyboardEvent)=>{const t=e.target instanceof HTMLElement?e.target:null;return !!t?.closest('input,textarea,select,[contenteditable=true],[contenteditable=plaintext-only],[role=dialog]');};
    const down=(e:KeyboardEvent)=>{if(e.defaultPrevented||e.isComposing||typing(e))return;const st=stateRef.current,command=e.metaKey||e.ctrlKey;
      // Hold Space over the timeline to pan; a tap still plays and pauses (on release).
      if((e.code==='Space'||e.key===' ')&&!command&&!e.altKey&&st.playPause&&(hovering.current||space.current.down)){e.preventDefault();if(!e.repeat&&!space.current.down){space.current={down:true,panned:false};setSpaceHeld(true);}return;}
      if(command&&!e.altKey&&e.key.toLowerCase()==='a'&&st.selectItems){e.preventDefault();st.selectItems(timelineSpans(st.project).map(span=>span.item));return;}
      if(command&&(e.key==='='||e.key==='+'||e.key==='-'||e.key==='_')){e.preventDefault();const box=scroll.current?.getBoundingClientRect();if(box)st.zoomTime(st.density*(e.key==='-'||e.key==='_'?1/1.5:1.5),box.left+box.width/2);return;}
      if(command||e.altKey)return;
      if(e.key==='Escape'&&st.selectedItems.length&&st.selectItems){st.selectItems([]);return;}
      const key=e.key.toLowerCase(),picked=editTools.find(item=>item.keys.toLowerCase().split(' or ').includes(key));
      if(picked&&st.selectItems){setEditTool(picked.id);return;}if(key==='s'&&st.selectItems){e.preventDefault();setSnapOn(v=>!v);}};
    const up=(e:KeyboardEvent)=>{if((e.code==='Space'||e.key===' ')&&space.current.down){e.preventDefault();const panned=space.current.panned;space.current={down:false,panned:false};setSpaceHeld(false);if(!panned)stateRef.current.playPause?.();}};
    const blur=()=>{if(space.current.down){space.current={down:false,panned:false};setSpaceHeld(false);}};
    studioKeys.addEventListener('keydown',down,true);studioKeys.addEventListener('keyup',up,true);window.addEventListener('blur',blur);
    return()=>{studioKeys.removeEventListener('keydown',down,true);studioKeys.removeEventListener('keyup',up,true);window.removeEventListener('blur',blur);};},[]);
  /** Hand, Blade and Zoom act before anything under the pointer does. */
  const toolPointerDown=(e:React.PointerEvent<HTMLDivElement>)=>{const target=e.target as HTMLElement,el=scroll.current;
    if(el&&(e.button===1||e.button===0&&(spaceHeld||editTool==='hand'))){e.preventDefault();e.stopPropagation();if(spaceHeld)space.current.panned=true;
      const x=e.clientX,y=e.clientY,left=el.scrollLeft,top=el.scrollTop;setPanning(true);
      const move=(m:PointerEvent)=>{el.scrollLeft=left-(m.clientX-x);el.scrollTop=top-(m.clientY-y);};
      const stop=()=>{setPanning(false);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);return;}
    if(e.button!==0||editTool==='select'||target.closest('.timeline-ruler'))return;
    e.preventDefault();e.stopPropagation();
    if(editTool==='zoom'){zoomTime(density*(e.altKey?1/2:2),e.clientX);return;}
    if(disabled||!changeProject)return;const box=laneRect();if(!box)return;const at=Math.round((e.clientX-box.left)/box.width*duration);
    const itemEl=target.closest<HTMLElement>('[data-item]'),clipEl=target.closest<HTMLElement>('[data-clip]');
    const item=itemEl?timelineSpans(project).find(span=>span.key===itemEl.dataset.item)?.item:undefined;
    if(item){const {project:next,created}=splitItem(project,item,at,cutId());
      if(!created){notify?.('Click inside the item, away from its edges, to cut it');return;}changeProject(()=>next);if(selectedItems.some(i=>itemKey(i)===itemKey(item)))selectItems?.([...selectedItems,created]);notify?.(`Cut at ${secondsLabel(at/fps)} · ⌘Z to undo`);return;}
    const scheduled=clipEl?schedule.find(s=>s.clip.id===clipEl.dataset.clip):undefined;
    if(scheduled){const local=at-scheduled.startFrame;if(local<=0||local>=scheduled.durationFrames)return;try{changeProject(p=>splitClip(p,scheduled.clip.id,local));notify?.(`Clip cut at ${secondsLabel(at/fps)} · ⌘Z to undo`);}catch(error){notify?.(error instanceof Error?error.message:String(error),true);}}};
  /** Rubber band on empty timeline space: everything it touches is selected (Shift/⌘ adds). A plain click moves the playhead and clears the selection. */
  const startMarquee=(e:React.PointerEvent<HTMLDivElement>,destination:number)=>{const root=area.current;if(!root)return;const box=root.getBoundingClientRect(),additive=e.shiftKey||e.metaKey||e.ctrlKey;
    const x0=e.clientX-box.left,y0=e.clientY-box.top;let dragged=false;
    const rect=(m:PointerEvent)=>{const b=root.getBoundingClientRect();return {x0:x0+box.left-b.left,y0:y0+box.top-b.top,x1:m.clientX-b.left,y1:m.clientY-b.top,b};};
    const move=(m:PointerEvent)=>{if(!dragged&&Math.hypot(m.clientX-e.clientX,m.clientY-e.clientY)<4)return;dragged=true;const r=rect(m);setMarquee({x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1});};
    const stop=(m:PointerEvent)=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);setMarquee(null);
      const st=stateRef.current;if(!dragged||m.type==='pointercancel'){if(m.type!=='pointercancel'){seek(destination);if(!additive&&st.selectedItems.length)st.selectItems?.([]);}return;}
      const r=rect(m),top=Math.min(r.y0,r.y1),bottom=Math.max(r.y0,r.y1),lanes=Array.from(root.querySelectorAll<HTMLElement>('[data-head]')).filter(el=>{const b=el.getBoundingClientRect(),t=b.top-r.b.top;return t<bottom&&t+b.height>top;}).map(el=>el.dataset.head!);
      const found=marqueeItems(st.project,Math.min(r.x0,r.x1)/r.b.width*duration,Math.max(r.x0,r.x1)/r.b.width*duration,lanes);
      st.selectItems?.(additive?[...st.selectedItems,...found.filter(i=>!st.selectedItems.some(o=>itemKey(o)===itemKey(i)))]:found);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);};
  // Right-click on the lanes: a clip, a layer, an audio segment, or empty space. What is right-clicked is selected
  // first (as a click would), so the menu acts on it and the inspector shows it.
  const openMenu=useContextMenu();
  const laneMenu=(e:React.MouseEvent)=>{
    if(disabled)return;const target=e.target as HTMLElement;
    if(target.closest('input,textarea,select'))return;
    const clipEl=target.closest<HTMLElement>('[data-clip]'),itemEl=target.closest<HTMLElement>('[data-item]');
    if(clipEl){const id=clipEl.dataset.clip!,s=schedule.find(x=>x.clip.id===id);if(!s)return;
      if(!(selectedIds.length===1&&selectedIds[0]===id))selectClip(id,false);
      const at=project.clips.findIndex(c=>c.id===id),inside=frame>s.startFrame&&frame<s.startFrame+s.durationFrames;
      openMenu(e,[{label:'Split at playhead',run:()=>split(),disabled:!inside},{label:'Add zoom at playhead',run:()=>addZoom(),disabled:!inside},{separator:true},
        {label:'Move earlier',run:()=>reorder(id,project.clips[at-1]!.id),disabled:at<=0},{label:'Move later',run:()=>reorder(id,project.clips[at+1]!.id),disabled:at>=project.clips.length-1},{separator:true},
        {label:'Delete clip',danger:true,run:()=>remove(),disabled:project.clips.length<2,hint:'⌫'}]);return;}
    const key=itemEl?.dataset.item;
    if(key?.startsWith('layer:')&&changeProject){const id=key.slice(6),layer=(project.layers??[]).find(l=>l.id===id);if(!layer)return;
      if(selectItems){if(!selectedItems.some(i=>itemKey(i)===key))pick({kind:'layer',id},'only');}else selectLayer?.(id);
      const order=(p:EditorProject,to:'front'|'back')=>{const list=(p.layers??[]).filter(l=>l.id!==id),it=(p.layers??[]).find(l=>l.id===id);return it?{...p,layers:to==='front'?[...list,it]:[it,...list]}:p;};
      const items:MenuItem[]=[{label:'Go to start',run:()=>seek(layer.startFrame)},
        {label:'Duplicate',run:()=>changeProject(p=>{const list=p.layers??[],at=list.findIndex(l=>l.id===id);if(at<0)return p;const copy={...structuredClone(list[at]!),id:`${id.slice(0,80)}-copy-${Math.random().toString(36).slice(2,7)}`,name:`${list[at]!.name.slice(0,94)} copy`};return{...p,layers:[...list.slice(0,at+1),copy,...list.slice(at+1)]};})},
        {separator:true},{label:'Bring to front',run:()=>changeProject(p=>order(p,'front'))},{label:'Send to back',run:()=>changeProject(p=>order(p,'back'))},{separator:true},
        {label:'Delete',danger:true,hint:'⌫',run:()=>{changeProject(p=>({...p,layers:(p.layers??[]).filter(l=>l.id!==id)}));if(selectItems)selectItems(selectedItems.filter(i=>itemKey(i)!==key));else selectLayer?.(null);}}];
      openMenu(e,items);return;}
    if(key?.startsWith('audio:')&&changeProject){const [,trackId,segmentId]=key.split(':') as [string,string,string],segment=project.audioTracks.find(t=>t.id===trackId)?.segments.find(x=>x.id===segmentId);if(!segment)return;
      if(selectItems&&!selectedItems.some(i=>itemKey(i)===key))pick({kind:'audio',trackId,segmentId},'only');
      openMenu(e,[{label:'Go to start',run:()=>seek(segment.startFrame)},{separator:true},
        {label:'Delete',danger:true,hint:'⌫',run:()=>{changeProject(p=>removeAudioSegment(p,trackId,segmentId));if(selectItems)selectItems(selectedItems.filter(i=>itemKey(i)!==key));}}]);return;}
    if(changeProject)openMenu(e,[{label:'Add text at playhead',run:()=>addLayer('text')},{label:'Add zoom at playhead',run:()=>addZoom()}]);
  };
  const seekPointer = (e: React.PointerEvent) => { const box = laneRect(); if (box) seek(Math.max(0, Math.min(duration - 1, Math.round((e.clientX - box.left) / box.width * duration)))); };
  return <section className={`timeline ${automationView?'automation-on':''}`}  aria-label="Editing timeline" style={{['--lane-scale' as string]:laneScale,['--track-h' as string]:`${TRACK_HEIGHT}px`}}>{trackHeightCss?<style>{trackHeightCss}</style>:null}<div className="timeline-toolbar"><div className="button-row">{selectItems&&changeProject?<div className="tl-tools" role="toolbar" aria-label="Edit tools">{editTools.map(item=><button key={item.id} aria-pressed={editTool===item.id} aria-label={item.label} onClick={()=>setEditTool(item.id)} title={`${item.label} (${item.keys}) — ${item.help}`}><EditToolIcon tool={item.id}/></button>)}<button className="tl-snap" aria-pressed={snapOn} aria-label="Snapping" onClick={()=>setSnapOn(v=>!v)} title={`Snapping (S) — ${snapOn?"on":"off"}: moves and trims snap to the playhead and to the edges of other items`}><EditToolIcon tool="snap"/></button></div>:null}<IconButton icon="split" label="Split selected clip at playhead" onClick={split} disabled={!!selectedWordIds.length||selectedIds.length !== 1}/><IconButton icon="trash" label={selectedItems.length?`Delete ${selectedItems.length} selected item${selectedItems.length===1?"":"s"}`:selectedLayerId?"Delete selected layer":selectedBeatIds.length?"Delete selected beats":selectedZoom?"Delete selected zoom":"Delete selected clips"} onClick={remove} disabled={!!selectedWordIds.length||!selectedItems.length&&!selectedLayerId&&!selectedBeatIds.length&&!selectedZoom&&(!selectedIds.length || selectedIds.length >= project.clips.length)}/><button onClick={append}><Icon name="plus" size={14}/>Add media</button>{toggleAutomation?<button className="automation-toggle" aria-pressed={!!automationView} onClick={toggleAutomation} title="Automation (A): every track gets a curve — pick what it controls in the track's header"><Icon name="automation" size={14}/>Automation</button>:null}{punchIn?<button className="timeline-punch" disabled={disabled} onClick={punchIn} title={selectedWordIds.length?'Record a new take that replaces the highlighted words':'Record a new take and insert it at the playhead'}><span className="rec-dot" />Punch in</button>:null}<button onClick={addZoom} disabled={disabled} title="Zoom in at the playhead (editable on the Zoom automation lane)"><Icon name="zoom" size={14}/>Add zoom</button>{changeProject?<div className="tl-menu"><button aria-expanded={menu==='add'} disabled={disabled} onClick={()=>setMenu(menu==='add'?null:'add')} title="Add text, callouts and captions at the playhead"><Icon name="plus" size={14}/>Add<Icon name="chevron" size={14}/></button>{menu==='add'?<div className="tl-menu-list" role="menu" ref={fitMenu}>
  <button role="menuitem" onClick={()=>addLayer('text')}><b>Text</b><small>Headline that blurs in — pick a look and animation in the inspector</small></button>
  <button role="menuitem" disabled={!words.length} onClick={()=>addLayer('kinetic')}><b>Word-by-word captions</b><small>{words.length?'Big TikTok-style captions from what you said':'Transcribe first'}</small></button>
  {(['notification','card','chips','particles','waveform','icons','ring','background','box','highlight','arrow','spotlight'] as const).map(kind=><button key={kind} role="menuitem" onClick={()=>addLayer(kind)}><b>{layerKindInfo[kind].label}</b><small>{layerKindInfo[kind].help}</small></button>)}
</div>:null}</div>:null}{changeProject?<div className="tl-menu"><button aria-expanded={menu==='transition'} disabled={disabled} onClick={()=>setMenu(menu==='transition'?null:'transition')} title="Add a transition at the playhead"><Icon name="transition" size={14}/>Transition<Icon name="chevron" size={14}/></button>{menu==='transition'?<div className="tl-menu-list" role="menu" ref={fitMenu}>
  {transitionKinds.map(item=><button key={item.id} role="menuitem" onClick={()=>addTransitionHere(item.id)}><b>{item.label}</b><small>{item.help}</small></button>)}
</div>:null}</div>:null}{changeProject&&layoutSources.length>1?<div className="tl-menu"><button aria-expanded={menu==='layout'} disabled={disabled||!layoutTargets.length} onClick={()=>setMenu(menu==='layout'?null:'layout')} title="Show several sources at once — side by side, stacked, picture-in-picture or a grid"><Icon name="layout" size={14}/>Layout<Icon name="chevron" size={14}/></button>{menu==='layout'?<div className="tl-menu-list" role="menu" ref={fitMenu}>
  {layoutPresets.map(item=><button key={item.id} role="menuitemradio" aria-checked={currentLayout===item.id} onClick={()=>applyLayout(item.id)}><b>{currentLayout===item.id?<Icon name="check" size={14}/>:null}{item.label}</b><small>{item.id==='single'?'Just the main source':item.id==='grid'?'Three or four sources':item.id==='pip'?'Main source full, another in a corner':'Two sources'}</small></button>)}
</div>:null}</div>:null}{changeProject&&studioCan('sound')?<SoundMenu projectId={project.id} at={at} disabled={disabled} notify={notify}/>:null}{changeProject&&studioCan('motionCheck')?<MotionCheck projectId={project.id} disabled={disabled} notify={notify}/>:null}{changeProject&&studioCan('productUi')?<ComponentsGallery projectId={project.id} at={at} disabled={disabled} notify={notify} beforeEdit={beforeServerEdit} afterEdit={afterServerEdit}/>:null}{changeProject&&studioCan('review')?<ReviewVideo projectId={project.id} disabled={disabled} notify={notify} seek={seconds=>seek(Math.round(seconds*fps))}/>:null}{automationView?<div className="auto-tools" role="toolbar" aria-label="Automation tools">{automationTools.map(item=><button key={item.id} aria-pressed={tool===item.id} aria-label={item.label} onClick={()=>setTool(item.id)} title={`${item.label} (${item.key}) — ${item.help}`}><ToolIcon tool={item.id}/></button>)}</div>:null}</div><div className="timeline-word-tools">{cleanUp&&cleanupIds.size?<button className="timeline-cleanup" disabled={disabled} onClick={cleanUp} title="Cut filler words (um, uh, like, you know) and stutters from the whole video"><Icon name="cleanup" size={14}/>Clean up · {cleanupIds.size}</button>:null}<button className="timeline-empty-toggle" aria-pressed={showEmptyTracks} onClick={()=>{finish(true);setShowEmptyTracks(value=>!value);}}>{showEmptyTracks?'Hide empty tracks':'Show empty tracks'}</button>{curveCount?<label className="timeline-density">Animation<select aria-label="Animation curve scope" value={allCurves?'all':'selection'} onChange={event=>{finish(true);setAllCurves(event.target.value==='all');}}><option value="selection">Selected object</option><option value="all">All curves</option></select></label>:null}{selectedWordIds.length?<button onClick={deleteWords} disabled={disabled||uncertain} title={uncertain?'Retranscribe incomplete timing before making word cuts':'Cuts linked footage and audio; Undo restores'}>Delete {selectedWords.length} word{selectedWords.length===1?'':'s'}</button>:<span className="keyboard-hint">Click words to select · Shift selects a range · ⌘/Ctrl adds</span>}<label className="timeline-density" title="Pinch or ⌘-swipe left/right to zoom time · ⌘-swipe up/down to make lanes taller · ⌘←/→ and ⌘↑/↓ from the keyboard">Zoom<select aria-label="Timeline density" value={Math.round(density*10)/10} onChange={e=>{finish(true);scrollStart.current=(scroll.current?.scrollLeft??0)/density;setDensity(Number(e.target.value));}}>{[...new Set([1,2,4,8,16,32,64,Math.round(density*10)/10])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value===1?'Fit':`${value}×`}</option>)}</select></label></div></div><div className="timeline-track-area"><div className="track-heads-col" onWheel={e=>{const box=scroll.current;if(box&&!e.ctrlKey&&!e.metaKey)box.scrollTop+=e.deltaY;}}>{area.current!==undefined?<TrackHeads custom={selectBeats?{storyboard:<StoryboardHead project={project} selected={selectedBeatIds} record={recordBeats} change={changeProject} recording={recording} beforeServerEdit={beforeServerEdit} afterServerEdit={afterServerEdit}/>}:undefined} area={area} project={project} schedule={schedule} frame={frame} automationView={!!automationView} params={trackParams} setParams={setTrackParams} change={changeProject} heights={trackHeights} setHeight={setTrackHeight} laneScale={laneScale} selectedLayerId={selectedLayerId} selectLayer={selectLayer} layoutKey={`${project.storyboard?.beats.length??0}:${automationView}:${showEmptyTracks}:${showLayers}:${project.audioTracks.length}:${laneScale}:${words.length>0}:${(project.layers??[]).map(layer=>layer.id).join(',')}`}/>:null}</div><div className="timeline-scroll" ref={scroll} onPointerEnter={()=>{hovering.current=true;}} onPointerLeave={()=>{hovering.current=false;}}><div ref={area} role="group" aria-label="Timeline lanes" tabIndex={0} onContextMenu={laneMenu} className={`timeline-lanes tool-${spaceHeld?'hand':editTool}${panning?' panning':''}`} style={{position:'relative',width:`${density*100}%`,minWidth:'100%'}} onPointerDownCapture={toolPointerDown} onPointerMove={e=>{if(editTool==="blade"){const box=area.current?.getBoundingClientRect();if(box)setBladeX((e.clientX-box.left)/box.width*100);}}} onPointerLeave={()=>setBladeX(null)} onPointerDown={e=>{if(e.button!==0||gesture.current||disabled)return;const target=e.target as HTMLElement;if(target.closest('button,input,select,textarea,[role=button],[role=slider],[draggable=true],.zoom-block,.trim-handle'))return;const box=laneRect()!,destination=emptyTimelineFrame(e.clientX,box.left,box.width,duration);if(destination!==null){e.preventDefault();e.currentTarget.focus({preventScroll:true});if(selectItems&&editTool==="select")startMarquee(e,destination);else seek(destination);}}}><div data-head="ruler" className="timeline-ruler" role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={duration - 1} aria-valuenow={frame} aria-valuetext={secondsLabel(frame / fps)} aria-orientation="horizontal" tabIndex={0} onKeyDown={(e) => {
    let destination: number | undefined;
    if(e.key==='Home')destination=0;
    else if(e.key==='End')destination=duration-1;
    else if(e.key==='PageUp')destination=frame+fps;
    else if(e.key==='PageDown')destination=frame-fps;
    else if(e.key==='ArrowLeft'||e.key==='ArrowDown')destination=frame-(e.shiftKey?10:1);
    else if(e.key==='ArrowRight'||e.key==='ArrowUp')destination=frame+(e.shiftKey?10:1);
    if(destination!==undefined){e.preventDefault();e.stopPropagation();seek(destination);}
  }} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekPointer(e); }} onPointerMove={(e) => { if(e.currentTarget.hasPointerCapture(e.pointerId)) seekPointer(e); }}>{Array.from({length:11},(_,i) => <span className="ruler-mark" key={i} style={{left:`${i * 10}%`,transform:i===10?'translateX(-100%)':undefined}}>{secondsLabel(duration / fps * i / 10)}</span>)}</div>
  {selectBeats&&(project.storyboard?.beats.length||changeProject)?<StoryboardLane project={project} duration={duration} disabled={disabled} selected={selectedBeatIds} select={selectBeats} seek={seek} change={changeProject} frame={frame} notify={notify}/>:null}
  {markers.length||showEmptyTracks?<div data-head="keys" className="keyboard-lane" aria-label="Recorded keyboard actions"><span className="sr-only">Keyboard actions from the recording</span>{markers.length?markers.map(m=><button key={m.id} className={`keyboard-marker ${m.kind}`} style={{left:`${m.startFrame/duration*100}%`,width:`${(m.endFrame-m.startFrame)/duration*100}%`}} title={`Recorded ${m.kind==='type'?'typing':'key press'}: ${m.label} · ${secondsLabel(m.startFrame/fps)}`} aria-label={`Seek to recorded ${m.kind==='type'?'typing':'key press'} ${m.label}`} onClick={event=>{selectClip(m.clipId,false);seek(m.startFrame);const actionIndex=Number(m.id.match(/-key-(\d+)$/)?.[1]);const suggestion=m.kind==='type'?suggestions.find(item=>item.clipId===m.clipId&&item.actionIndex===actionIndex):undefined;if(suggestion&&onTyping){const box=event.currentTarget.getBoundingClientRect();setTypingPopup({suggestionId:suggestion.id,clipId:m.clipId,x:Math.max(8,Math.min(box.left,window.innerWidth-282)),y:Math.max(8,Math.min(box.bottom+6,window.innerHeight-240))});setTypingRate(2);}else setTypingPopup(null);}}><Icon name="keyboard" size={14}/></button>):<span className="keyboard-empty">{hasKeyboardTrace?'No keyboard actions in this trim':'No keyboard trace in this recording'}</span>}</div>:null}
  {words.length||showEmptyTracks?<div ref={wordLane} data-head="words" className="word-lane" onPointerMove={e=>{if(!wordDrag.current||!(e.buttons&1))return;const box=e.currentTarget.getBoundingClientRect(),at=(e.clientX-box.left)/box.width*duration;const row=wordLayout.reliable.find(item=>at>=item.startFrame&&at<item.startFrame+(wordLayout.span.get(item.id)??1));if(row&&row.id!==wordDrag.last){wordDrag.last=row.id;selectWord(row.id,false,true);}}} aria-label="Timed transcript words"><span className="word-track-label">Words{mixedWords?' · recording / voiceover':''}</span>{words.length?wordLayout.reliable.map(row=><button key={row.id} className={`timeline-word ${wordLayout.shown.has(row.id)?'':'compact'} ${selectedWordIds.includes(row.id)?'selected':''} ${cleanupIds.has(row.id)?'filler':''} ${frame>=row.startFrame&&frame<row.endFrame?'current':''}`} style={{left:`${row.startFrame/duration*100}%`,width:`${(wordLayout.span.get(row.id)??row.endFrame-row.startFrame)/duration*100}%`,top:mixedWords&&row.sourceKind==='voiceover'?40:14}} disabled={disabled} aria-pressed={selectedWordIds.includes(row.id)} aria-label={`Select word ${row.text} at ${secondsLabel(row.startFrame/fps)}`} title={`${project.captionCorrections[row.wordId]??row.text} · ${secondsLabel(row.startFrame/fps)}${cleanupIds.has(row.id)?' · filler/repeat — Clean up removes it':''} · drag across words to select · Delete removes`}
    onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();wordDrag.current=true;wordDrag.last=row.id;selectWord(row.id,e.metaKey||e.ctrlKey,e.shiftKey);}}
    onClick={e=>{if(e.detail===0)selectWord(row.id,e.metaKey||e.ctrlKey,e.shiftKey);}}>{project.captionCorrections[row.wordId]??row.text}</button>):<span className="word-track-empty">Open Transcript to transcribe a recording and edit its words here</span>}{points.map(group=>{const row=group[0]!;return <button key={row.id} className={`timeline-word-point ${group.some(w=>selectedWordIds.includes(w.id))?'selected':''}`} style={{left:`${row.startFrame/duration*100}%`,top:mixedWords&&row.sourceKind==='voiceover'?43:16}} disabled={disabled} aria-pressed={group.some(w=>selectedWordIds.includes(w.id))} aria-label={`Timing incomplete: ${group.map(w=>w.text).join(' ')}; seek only, no word cut`} title={`${group.map(w=>w.text).join(' ')} · reported anchor ${secondsLabel(row.startFrame/fps)} · Timing incomplete; retranscribe before cutting`} onClick={e=>selectWord(row.id,e.metaKey||e.ctrlKey,e.shiftKey)}>?</button>;})}</div>:null}
  <div data-head="audio" className="clip-lane" title="The main edit: trim or delete here and the screen, slides, camera and voice are cut together"><span className="sr-only">Video clips</span>{automationView&&changeProject&&audioParam!=='off'?<span className="lane-automation" onPointerDown={event=>event.stopPropagation()}><AutomationOverlay info={paramInfo('volume')} points={lanePoints(project,'volume')} setPoints={points=>changeProject(p=>setLanePoints(p,'volume',points))} tool={tool} tone={paramTone.volume} duration={duration} disabled={disabled} beginEdit={beginEdit} endEdit={endEdit} seek={seek}/></span>:null}{schedule.map(s => {const {clip,asset,durationFrames}=s;const waveform=asset.waveform?.slice(Math.floor(clip.trimStartSourceFrame / asset.sourceFrames! * asset.waveform.length),Math.ceil(clip.trimEndSourceFrame / asset.sourceFrames! * asset.waveform.length));return <div key={clip.id} data-clip={clip.id} className={`clip-block ${!selectedWordIds.length&&selectedIds.includes(clip.id)?'active':''}`} style={{width:`${durationFrames / duration * 100}%`}} draggable onDragStart={e=>{if((e.target as HTMLElement).closest('.trim-handle')){e.preventDefault();return;}drag.current=clip.id;}} onDragEnd={()=>{drag.current=null;}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag.current)reorder(drag.current,clip.id);drag.current=null;}}>
    <button className="clip-select" onClick={e=>selectClip(clip.id,e.metaKey||e.ctrlKey||e.shiftKey)} onDoubleClick={()=>seek(s.startFrame)} aria-label={`Select clip ${asset.name}`} aria-pressed={selectedIds.includes(clip.id)}><span className="clip-title">{asset.name}</span><span className="clip-duration">{secondsLabel(durationFrames/fps)} · {clip.playbackRate}×</span></button>{clip.transitionIn?<span className={`clip-transition ${clip.transitionIn.kind}`} title={`${clip.transitionIn.kind==='dissolve'?'Dissolve':clip.transitionIn.kind==='dip-black'?'Dip to black':'Dip to white'} · ${clip.transitionIn.seconds.toFixed(2)} s`} aria-label="Transition in"/>:null}{clip.transitionOut?<span className={`clip-transition out ${clip.transitionOut.kind}`} title={`Fade out · ${clip.transitionOut.seconds.toFixed(2)} s`} aria-label="Fade out"/>:null}{waveform?.length?<Waveform values={waveform}/>:null}
    {(['start','end'] as const).map(mode=><button key={mode} className={`trim-handle clip-trim ${mode}`} disabled={disabled} aria-label={`Trim clip ${asset.name} ${mode}`} title={`Drag to trim ${mode} · Arrow keys adjust`} onPointerDown={e=>start(e,s,mode)} {...pointerHandlers} onClick={e=>e.stopPropagation()} onKeyDown={e=>nudge(e,s,mode)}/>)}
  </div>;})}</div>
  {changeProject&&layoutSources.length>1?<LayoutLane project={project} duration={duration} disabled={disabled} change={changeProject} beginEdit={beginEdit} endEdit={endEdit} seek={seek} notify={notify}
    selectClips={ids=>{ids.forEach((id,index)=>selectClip(id,index>0));}}/>:null}
  {setShot?<ShotLanes project={project} schedule={schedule} duration={duration} disabled={disabled} setShot={setShot} seek={seek} selectedIds={selectedWordIds.length?[]:selectedIds} selectClip={selectClip} overlay={automationView&&changeProject&&pictureParam!=='off'?<AutomationOverlay info={paramInfo(pictureParam)} points={lanePoints(project,pictureParam)} setPoints={points=>changeProject(p=>setLanePoints(p,pictureParam,points))} tool={tool} tone={paramTone[pictureParam]} duration={duration} disabled={disabled} beginEdit={beginEdit} endEdit={endEdit} seek={seek}/>:null}/>:null}
  {changeProject&&selectLayer?<LayerLanes project={project} duration={duration} disabled={disabled} selectedLayerId={selectedLayerId} selectLayer={selectLayer} change={changeProject} beginEdit={beginEdit} endEdit={endEdit} seek={seek} automationView={!!automationView} params={trackParams} tool={tool} selection={selectedItems} pick={selectItems?pick:undefined} snap={snapper}/>:null}
  {hasZooms||showEmptyTracks?<div data-head="clipzoom" className="zoom-lane"><span className="sr-only">Zoom segments</span>{schedule.flatMap(s => s.clip.zooms.map(z=><div key={`${s.clip.id}-${z.id}`} className={`zoom-block ${selectedZoom===z.id&&selectedIds.includes(s.clip.id)?'active':''}`} style={{left:`${(s.startFrame+z.startClipFrame)/duration*100}%`,width:`${(z.endClipFrame-z.startClipFrame)/duration*100}%`}}>
    <button className="zoom-move" disabled={disabled} aria-label={`Move zoom ${z.scale.toFixed(1)} times`} aria-pressed={selectedZoom===z.id&&selectedIds.includes(s.clip.id)} title="Drag to move zoom · Arrow keys adjust" onPointerDown={e=>start(e,s,'move',z)} {...pointerHandlers} onClick={()=>selectZoom(s.clip.id,z.id)} onKeyDown={e=>nudge(e,s,'move',z)}><span className="zoom-title">Zoom</span><span className="zoom-value"><Icon name="zoom" size={12}/>{z.scale.toFixed(1)}×</span></button>
    {(['start','end'] as const).map(mode=><button key={mode} className={`trim-handle zoom-trim ${mode}`} disabled={disabled} aria-label={`Trim zoom ${z.scale.toFixed(1)} times ${mode}`} title={`Drag to trim ${mode} · Arrow keys adjust`} onPointerDown={e=>start(e,s,mode,z)} {...pointerHandlers} onClick={e=>{e.stopPropagation();selectZoom(s.clip.id,z.id);}} onKeyDown={e=>nudge(e,s,mode,z)}/>)}
  </div>))}</div>:null}

  {layerCount||showEmptyTracks?<div data-head="layers" className="auxiliary-lane motion-lane-heading"><button className="track-group-toggle" aria-expanded={showLayers} onClick={()=>{finish(true);setShowLayers(value=>!value);}}><Icon name={showLayers?'chevron':'chevronRight'} size={14}/>Layers · {layerCount}</button></div>:null}
  {showLayers?schedule.flatMap(item=>item.clip.motion.layers.map(layer=><div key={`${item.clip.id}-${layer.id}`} className="auxiliary-lane motion-layer-lane" aria-label={`${layer.name} visual layer`}><div className={`motion-layer-span ${selectedIds.includes(item.clip.id)&&selectedMotionLayerId===layer.id?'active':''}`} style={{left:`${(item.startFrame+layer.startFrame)/duration*100}%`,width:`${(layer.endFrame-layer.startFrame)/duration*100}%`}}><button className="motion-layer-move" disabled={disabled} aria-label={`Move ${layer.name} layer`} title={`${layer.name} · drag to move · Arrow keys adjust`} onClick={()=>selectMotion(item.clip.id,layer.id,null)} onPointerDown={event=>startLayer(event,item,layer,'move')} onKeyDown={event=>nudgeLayer(event,item,layer,'move')} {...pointerHandlers}>{layer.name}</button>{(['start','end'] as const).map(mode=><button key={mode} className={`motion-layer-trim ${mode}`} disabled={disabled} aria-label={`Trim ${layer.name} layer ${mode}`} title={`Drag to trim ${mode} · Arrow keys adjust`} onPointerDown={event=>startLayer(event,item,layer,mode)} onKeyDown={event=>nudgeLayer(event,item,layer,mode)} {...pointerHandlers}/>)}</div></div>)):null}
  {curveCount||showEmptyTracks?<div data-head="animation" className="auxiliary-lane motion-lane-heading"><span className="track-label">Animation · {allCurves?'All curves':'Selected object'}</span></div>:null}
  {curveRows.map(({item,track})=>{const target=track.target==='primary'?'Screen':item.clip.motion.layers.find(layer=>layer.id===track.target)?.name??'Layer';return <div key={`${item.clip.id}-${track.id}`} className="auxiliary-lane motion-track-lane" aria-label={`${target} ${motionPropertyLabels[track.property]} animation curve`}><button className={`motion-track-span ${selectedIds.includes(item.clip.id)&&selectedMotionTrackId===track.id?'active':''}`} style={{left:`${item.startFrame/duration*100}%`,width:`${item.durationFrames/duration*100}%`}} aria-label={`Edit ${target} ${motionPropertyLabels[track.property]} animation curve`} onClick={()=>selectMotion(item.clip.id,track.target,track.id)}>{target} · {motionPropertyLabels[track.property]}</button></div>;})}
  {curveCount&&!curveRows.length?<p className="timeline-context-empty">{motionClip?'No animation curves for the selected object.':'Select one clip to see its animation curves.'}</p>:null}
  {motionTrack&&motionClip?<MotionCurveLane key={`${motionClip.clip.id}-${motionTrack.id}`} track={motionTrack} duration={motionClip.durationFrames} disabled={disabled} edit={next=>editMotion(motionClip.clip.id,next)} beginEdit={beginEdit} endEdit={endEdit}/>:null}
  <AudioLanes project={project} duration={duration} disabled={disabled} selection={selectedItems} pick={changeProject&&selectItems?pick:undefined} snap={snapper} change={changeProject} beginEdit={beginEdit} endEdit={endEdit} seek={seek}/>{marquee?<div className="tl-marquee" style={{left:Math.min(marquee.x0,marquee.x1),top:Math.min(marquee.y0,marquee.y1),width:Math.abs(marquee.x1-marquee.x0),height:Math.abs(marquee.y1-marquee.y0)}}/>:null}{editTool==='blade'&&bladeX!==null&&!spaceHeld?<div className="tl-blade-line" style={{left:`${bladeX}%`}}/>:null}<LivePlayhead frame={frame} duration={duration}/></div></div></div>{typingPopup&&activeSuggestion&&onTyping&&typeof document!=='undefined'?createPortal(<div className="typing-popover" role="dialog" aria-label="Typing speed" style={{left:typingPopup.x,top:typingPopup.y}} onPointerDown={event=>event.stopPropagation()}><div className="typing-popover-head"><strong>Speed up typing</strong><button aria-label="Close typing speed" title="Close" onClick={()=>setTypingPopup(null)}><Icon name="close" size={14}/></button></div><small>{activeSuggestion.label} · {secondsLabel((activeSuggestion.endFrame-activeSuggestion.startFrame)/fps)}</small>{activeSuggestion.reason?<p className="hint">{activeSuggestion.reason}</p>:null}<label>Speed <strong>{typingRate.toFixed(2).replace(/\.00$/,'')}×</strong><input aria-label="Typing speed" type="range" min="1" max="4" step="0.25" value={typingRate} onChange={event=>setTypingRate(Number(event.target.value))}/></label><div className="typing-popover-actions"><button disabled={disabled||activeTypingClip?.playbackRate===1} onClick={()=>{onTyping('reset',typingPopup.clipId,1);setTypingPopup(null);}}>Reset</button><button disabled={disabled||!suggestions.some(item=>item.eligible)||typingRate===1} onClick={()=>{onTyping('all',typingPopup.suggestionId,typingRate);setTypingPopup(null);}}>Apply all</button><button className="primary" disabled={disabled||!activeSuggestion.eligible||typingRate===1} onClick={()=>{onTyping('apply',typingPopup.suggestionId,typingRate);setTypingPopup(null);}}>Apply</button><button disabled={disabled} onClick={()=>{onTyping('remove',typingPopup.suggestionId,typingRate);setTypingPopup(null);}}>Remove</button></div></div>, studioPortal()):null}</section>;
}

type EditTool='select'|'hand'|'blade'|'zoom';
const editTools:{id:EditTool;label:string;keys:string;help:string}[]=[
  {id:'select',label:'Select',keys:'V',help:'click to select · Shift-click a range · ⌘-click to add or remove · drag empty space to marquee · ⌘A selects all, Esc clears'},
  {id:'hand',label:'Hand',keys:'H',help:'drag to scroll the timeline · or hold Space over it'},
  {id:'blade',label:'Blade',keys:'B or C',help:'click a sound, layer or clip to cut it there'},
  {id:'zoom',label:'Zoom',keys:'Z',help:'click to zoom in, ⌥-click to zoom out · ⌘+ / ⌘− and ⌘-scroll too'}];
/** The edit tool palette's icons. */
function EditToolIcon({tool}:{tool:EditTool|'snap'}){
  return <Icon name={({select:'select',hand:'hand',blade:'blade',zoom:'zoom',snap:'snap'} as const)[tool]}/>;
}

/** The automation toolbar's icons. */
function ToolIcon({tool}:{tool:AutomationTool}){
  return <Icon name={({pointer:'select',pencil:'pencil',line:'line',eraser:'eraser'} as const)[tool]}/>;
}

/** The playhead line follows playback every frame on its own (the rest of the timeline updates a few times a second). */
function LivePlayhead({ frame, duration }: { frame: number; duration: number }) {
  const live = useLiveFrame(), shown = Math.abs(live - frame) > 0 ? live : frame;
  return <div className="playhead" style={{ left: `${shown / duration * 100}%` }} />;
}
