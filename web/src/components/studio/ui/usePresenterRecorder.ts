import {useCallback,useEffect,useRef,useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import type {EditorAsset,EditorProject} from '@/lib/studio/engine/contracts';
import {projectDuration} from '@/lib/studio/engine/timeline';
import {importPresenter} from './client';

type Phase='idle'|'requesting'|'ready'|'countdown'|'recording'|'finalizing'|'error';
type Context={projectId:string;signature:string;duration:number;maxFrame:number;progressAt:number;startedAt:number;name:string};
type Options={projectId:string|null;readProject:()=>EditorProject|null|undefined;getPlayer:()=>PlayerRef|null;setLock:(locked:boolean)=>void;attach:(asset:EditorAsset,projectId:string,signature:string,maxFrames?:number)=>boolean;retain:(asset:EditorAsset)=>void;notify:(message:string,error?:boolean)=>void};
const failure=(error:unknown)=>error instanceof Error?error.message:String(error);
export function usePresenterRecorder({projectId,readProject,getPlayer,setLock,attach,retain,notify}:Options){
 const [phase,setPhase]=useState<Phase>('idle'),[countdown,setCountdown]=useState(3),[error,setError]=useState<string|null>(null),[partial,setPartial]=useState<string|null>(null),[rawUrl,setRawUrl]=useState<string|null>(null);
 const mounted=useRef(true),deviceRequest=useRef(0),deviceOwner=useRef<string|null>(null),phaseRef=useRef<Phase>('idle'),stream=useRef<MediaStream|null>(null),recorder=useRef<MediaRecorder|null>(null),chunks=useRef<Blob[]>([]),context=useRef<Context|null>(null),countTimer=useRef<ReturnType<typeof setTimeout>|null>(null),watchTimer=useRef<ReturnType<typeof setInterval>|null>(null),raw=useRef<Blob|null>(null),rawUrlRef=useRef<string|null>(null),video=useRef<HTMLVideoElement|null>(null);
 const update=(next:Phase)=>{phaseRef.current=next;setPhase(next);};
 const stopTracks=()=>{for(const track of stream.current?.getTracks()??[])track.stop();stream.current=null;if(video.current)video.current.srcObject=null;};
 const clearTimers=()=>{if(countTimer.current)clearTimeout(countTimer.current);if(watchTimer.current)clearInterval(watchTimer.current);countTimer.current=null;watchTimer.current=null;};
 const clearRawUrl=()=>{if(rawUrlRef.current)URL.revokeObjectURL(rawUrlRef.current);rawUrlRef.current=null;setRawUrl(null);};
 const importRaw=useCallback(async(blob:Blob,source:Context)=>{try{
   const extension=blob.type.includes('mp4')?'mp4':'webm';
   const {asset}=await importPresenter<{asset:EditorAsset;rawSha256:string;rawBytes:number}>(blob,`${source.name}.${extension}`);
   const measured=Math.min(source.duration,source.maxFrame+1);
   const applied=measured>1&&attach(asset,source.projectId,source.signature,measured);
   if(!applied){retain(asset);notify(measured<=1?'The presenter recording was kept, but the walkthrough did not play far enough to attach it.':'The presenter recording was kept. The video changed, so it was not attached automatically.',true);}
   else notify(measured<source.duration?'Presenter added for the recorded portion of the walkthrough.':'Presenter added across the walkthrough.');
   raw.current=null;context.current=null;deviceOwner.current=null;setPartial(measured<source.duration?'Part of the recording was kept':'Recording complete');clearRawUrl();setError(null);update('idle');
  }catch(e){setError(`Presenter video could not be imported: ${failure(e)}. The raw recording remains available to retry or download.`);update('error');}finally{setLock(false);}
 },[attach,retain,notify,setLock,rawUrl]);
 const stop=useCallback((reason='Stopped')=>{if(phaseRef.current!=='recording')return;update('finalizing');clearTimers();getPlayer()?.pause();const source=context.current;if(source){source.maxFrame=Math.max(source.maxFrame,getPlayer()?.getCurrentFrame()??0);setPartial(reason);}try{recorder.current?.stop();}catch(e){setError(`Recording stopped unexpectedly: ${failure(e)}`);update('error');setLock(false);}stopTracks();},[getPlayer,setLock]);
 const prepare=useCallback(async()=>{if(phaseRef.current!=='idle'&&phaseRef.current!=='error'||raw.current)return;const project=readProject();if(!project)return;const request=++deviceRequest.current;deviceOwner.current=project.id;setError(null);setPartial(null);update('requesting');try{
   if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error('Webcam and microphone recording is unavailable in this browser. Import a presenter video instead.');
   const acquired=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
   if(!mounted.current||request!==deviceRequest.current||readProject()?.id!==project.id||(phaseRef.current as Phase)!=='requesting'){for(const track of acquired.getTracks())track.stop();return;}
   if(!acquired.getVideoTracks().length||!acquired.getAudioTracks().length){for(const track of acquired.getTracks())track.stop();throw new Error('A webcam and microphone are both required for presenter recording.');}
   stream.current=acquired;if(video.current){video.current.srcObject=acquired;void video.current.play().catch(()=>{});}update('ready');
  }catch(e){if(!mounted.current||request!==deviceRequest.current)return;setError(`Camera or microphone could not start: ${failure(e)}`);update('error');stopTracks();}
 },[readProject]);
 const cancel=useCallback(()=>{if(phaseRef.current==='recording'){stop('Stopped early');return;}deviceRequest.current++;deviceOwner.current=null;context.current=null;clearTimers();stopTracks();setLock(false);update('idle');},[setLock,stop]);
 const begin=useCallback(()=>{if(phaseRef.current!=='ready'||!stream.current)return;const project=readProject();if(!project)return;const baseline=JSON.stringify(project);context.current={projectId:project.id,signature:baseline,duration:projectDuration(project),maxFrame:0,progressAt:0,startedAt:0,name:`Presenter-${new Date().toISOString().replace(/[:.]/g,'-')}`};setLock(true);update('countdown');setCountdown(3);
   const tick=(remaining:number)=>{if(phaseRef.current!=='countdown')return;if(remaining>0){setCountdown(remaining);countTimer.current=setTimeout(()=>tick(remaining-1),1000);return;}
    const source=context.current,latest=readProject();if(!source||!latest||latest.id!==source.projectId||JSON.stringify(latest)!==source.signature){setError('The edit changed during countdown. Start presenter recording again.');cancel();return;}
    try{const formats=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];const mimeType=formats.find(value=>MediaRecorder.isTypeSupported(value));const media=new MediaRecorder(stream.current!,mimeType?{mimeType}:undefined);recorder.current=media;chunks.current=[];
      media.ondataavailable=event=>{if(event.data.size)chunks.current.push(event.data);};
      media.onerror=event=>{setError(`Webcam recording failed: ${String(event)}`);stop('Interrupted');};
      media.onstop=()=>{const blob=new Blob(chunks.current,{type:media.mimeType||'video/webm'});raw.current=blob;recorder.current=null;const source=context.current;if(blob.size&&source){clearRawUrl();rawUrlRef.current=URL.createObjectURL(blob);setRawUrl(rawUrlRef.current);void importRaw(blob,source);}else{setError('No presenter footage was recorded.');update('error');setLock(false);}};
      getPlayer()?.pause();getPlayer()?.seekTo(0);media.start(250);source.startedAt=performance.now();source.progressAt=source.startedAt;update('recording');getPlayer()?.play();
      watchTimer.current=setInterval(()=>{const current=context.current;if(phaseRef.current==='recording'&&current&&performance.now()-current.progressAt>2500&&current.maxFrame<current.duration-1)stop('The preview stopped playing; the footage so far was kept');},500);
    }catch(e){setError(`Webcam recording could not start: ${failure(e)}`);stopTracks();setLock(false);update('error');}
   };tick(3);
 },[readProject,getPlayer,setLock,cancel,importRaw,stop]);
 const noteFrame=useCallback((frame:number)=>{const source=context.current;if(phaseRef.current!=='recording'||!source)return;if(frame>source.maxFrame){source.maxFrame=frame;source.progressAt=performance.now();}},[]);
 const onEnded=useCallback(()=>{if(phaseRef.current==='recording')stop('Recording complete');},[stop]);
 const onWaiting=useCallback(()=>{if(phaseRef.current==='recording')stop('The preview paused while loading; the footage so far was kept');},[stop]);
 const importFile=useCallback(async(file:File)=>{const project=readProject();if(!project||raw.current||phaseRef.current!=='idle'&&phaseRef.current!=='error')return;const source:Context={projectId:project.id,signature:JSON.stringify(project),duration:projectDuration(project),maxFrame:projectDuration(project)-1,progressAt:0,startedAt:0,name:file.name.replace(/\.[^.]+$/,'')};context.current=source;raw.current=file;clearRawUrl();rawUrlRef.current=URL.createObjectURL(file);setRawUrl(rawUrlRef.current);setError(null);update('finalizing');await importRaw(file,source);},[readProject,importRaw]);
 const retry=useCallback(()=>{if(raw.current&&context.current){update('finalizing');void importRaw(raw.current,context.current);}},[importRaw]);
 const discardRaw=useCallback(()=>{if(phaseRef.current!=='error')return;raw.current=null;context.current=null;deviceOwner.current=null;clearRawUrl();setError(null);setPartial(null);update('idle');},[]);
 const videoRef=useCallback((node:HTMLVideoElement|null)=>{video.current=node;if(node&&stream.current){node.srcObject=stream.current;void node.play().catch(()=>{});}},[]);
 useEffect(()=>{const owner=context.current?.projectId??deviceOwner.current;if(owner&&projectId!==owner){if(phaseRef.current==='recording')stop('The video changed; the footage so far was kept');else if(phaseRef.current==='countdown'||phaseRef.current==='ready'||phaseRef.current==='requesting')cancel();}},[projectId,stop,cancel]);
 useEffect(()=>{const hidden=()=>{if(document.hidden&&phaseRef.current==='recording')stop('The tab was hidden; the footage so far was kept');};document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden);},[stop]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;deviceRequest.current++;clearTimers();if(phaseRef.current==='recording')try{recorder.current?.stop();}catch{}stopTracks();if(rawUrlRef.current)URL.revokeObjectURL(rawUrlRef.current);setLock(false);};},[setLock]);
 return {phase,countdown,error,partial,rawUrl,videoRef,prepare,begin,cancel,stop,importFile,retry,discardRaw,noteFrame,onEnded,onWaiting,active:phase==='countdown'||phase==='recording'||phase==='finalizing'};
}
