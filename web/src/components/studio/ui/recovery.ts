import { parseEditorProject, type EditorProject } from '@/lib/studio/engine/contracts';

export type RecoveryDraft={project:EditorProject;baseDigest:string|null|undefined;baseSignature:string|undefined;savedAt?:number};
/** Legacy recovery values contain only the project and must not inherit a newer saved digest. */
export function parseRecoveryDraft(raw:string):RecoveryDraft{
 const value=JSON.parse(raw);
 if(value?.kind==='editor-recovery-v2'&&value.project){
  return {project:parseEditorProject(value.project),baseDigest:typeof value.baseDigest==='string'||value.baseDigest===null?value.baseDigest:undefined,baseSignature:typeof value.baseSignature==='string'?value.baseSignature:undefined,...(typeof value.savedAt==='number'?{savedAt:value.savedAt}:{})};
 }
 return {project:parseEditorProject(value),baseDigest:undefined,baseSignature:undefined};
}
export function recoveryMatchesSaved(draft:RecoveryDraft,savedProject:EditorProject,savedDigest:string):boolean{
 return draft.project.id===savedProject.id&&draft.baseDigest===savedDigest&&draft.baseSignature===JSON.stringify(savedProject);
}
export function recoveryCopy(draft:EditorProject,newId:string):EditorProject{
 return {...draft,id:newId,title:`${draft.title} (recovered copy)`};
}
export function serializeRecoveryDraft(project:EditorProject,baseDigest:string|null|undefined,baseSignature:string):string{
 return JSON.stringify({kind:'editor-recovery-v2',project,baseDigest,baseSignature,savedAt:Date.now()});
}
