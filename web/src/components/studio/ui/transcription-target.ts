import { EditorProjectSchema, type EditorProject, type EditorTranscript } from '@/lib/studio/engine/contracts';
export type TranscriptionTarget={projectId:string;assetId:string;sourceSha256:string;clipIds:string[];segmentIds:string[];previousTranscriptId?:string;corrections:string};
export function transcriptionTargetStillPresent(project:EditorProject|undefined,target:TranscriptionTarget):boolean {
  return !!project&&project.id===target.projectId&&project.assets.some(asset=>asset.id===target.assetId&&asset.sha256===target.sourceSha256)
    &&(project.clips.some(clip=>target.clipIds.includes(clip.id)&&clip.assetId===target.assetId)
      ||project.audioTracks.some(track=>track.segments.some(segment=>target.segmentIds.includes(segment.id)&&segment.assetId===target.assetId)));
}
export function transcriptionTarget(project:EditorProject,assetId:string,clipIds?:string[],segmentIds?:string[]):TranscriptionTarget {
  const asset=project.assets.find(a=>a.id===assetId);if(!asset)throw new Error('This source is no longer in the project.');
  const previous=project.transcripts.find(t=>t.assetId===assetId);
  return {projectId:project.id,assetId,sourceSha256:asset.sha256,clipIds:clipIds??project.clips.filter(c=>c.assetId===assetId).map(c=>c.id),segmentIds:segmentIds??project.audioTracks.flatMap(t=>t.segments.filter(s=>s.assetId===assetId).map(s=>s.id)),previousTranscriptId:previous?.id,corrections:JSON.stringify(previous?.words.map(w=>[w.id,project.captionCorrections[w.id]??null])??[])};
}
export function attachTranscription(project:EditorProject,target:TranscriptionTarget,transcript:EditorTranscript):{project:EditorProject;reason?:string}{
  const reject=(reason:string)=>({project,reason});
  if(project.id!==target.projectId)return reject('The original project is no longer open. This result remains available.');
  if(transcript.assetId!==target.assetId||transcript.sourceSha256!==target.sourceSha256)return reject('Transcript identity differs from the imported recording.');
  const asset=project.assets.find(a=>a.id===target.assetId);
  if(!asset||asset.sha256!==target.sourceSha256)return reject('The original media is no longer in this project.');
  if(!project.clips.some(c=>target.clipIds.includes(c.id)&&c.assetId===target.assetId)&&!project.audioTracks.some(t=>t.segments.some(s=>target.segmentIds.includes(s.id)&&s.assetId===target.assetId)))return reject('The intended clip or audio segment was removed. Attach this result to a remaining source explicitly.');
  const current=project.transcripts.find(t=>t.assetId===target.assetId);
  if(current?.id===transcript.id)return {project};
  if(current?.id!==target.previousTranscriptId)return reject('Another alignment was attached while transcription ran. Your current alignment was preserved.');
  if(JSON.stringify(current?.words.map(w=>[w.id,project.captionCorrections[w.id]??null])??[])!==target.corrections)return reject('Caption corrections changed while transcription ran. Your corrections were preserved.');
  const transcripts=[...project.transcripts.filter(t=>t.assetId!==target.assetId),transcript],valid=new Set(transcripts.flatMap(t=>t.words.map(w=>w.id)));
  return {project:EditorProjectSchema.parse({...project,transcripts,captionCorrections:Object.fromEntries(Object.entries(project.captionCorrections).filter(([id])=>valid.has(id)))})};
}
