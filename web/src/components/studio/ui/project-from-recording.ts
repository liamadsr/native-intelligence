import { EditorProjectSchema,defaultCaptions,defaultPresentation,type EditorAsset,type EditorProject } from '@/lib/studio/engine/contracts';
export function projectFromRecording(current:EditorProject,asset:EditorAsset,projectId:string,clipId:string):EditorProject{
  if(asset.kind!=='video'||!asset.sourceFps||!asset.sourceFrames)throw new Error('Choose a video recording with measured timing.');
  const fps=Math.round(asset.sourceFps);
  if(Math.abs(fps-asset.sourceFps)>1e-6||fps<1||fps>60)throw new Error('A new video needs a whole-number frame rate between 1 and 60 fps. Convert this recording to a supported frame rate first.');
  const width=Math.max(64,Math.round(asset.width!/2)*2),height=Math.max(64,Math.round(asset.height!/2)*2);
  if(width>8192||height>8192)throw new Error('This source exceeds the editor output limit. Use a recording at 8192 pixels or less per side.');
  const transcripts=current.transcripts.filter(t=>t.assetId===asset.id),wordIds=new Set(transcripts.flatMap(t=>t.words.map(w=>w.id)));
  return EditorProjectSchema.parse({schemaVersion:3,id:projectId,title:asset.name.slice(0,220)+' · recording',output:{width,height,fps},assets:[asset],clips:[{id:clipId,assetId:asset.id,trimStartSourceFrame:0,trimEndSourceFrame:asset.sourceFrames,audio:{muted:false,gain:1},holdEndFrames:0,zooms:[]}],presentation:structuredClone(defaultPresentation),cursor:{style:'none',size:18,clickFeedback:false},audioTracks:[],transcripts,captions:structuredClone(defaultCaptions),captionCorrections:Object.fromEntries(Object.entries(current.captionCorrections).filter(([id])=>wordIds.has(id))),voiceoverDraft:{text:'',targetClipIds:[]}});
}
