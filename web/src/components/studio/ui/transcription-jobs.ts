import type { EditorJob } from '@/lib/studio/engine/api';
export const transcriptionJobPhase=(job:EditorJob):'running'|'finished'=>job.status==='running'?'running':'finished';
export const successfulTranscript=(job:EditorJob|undefined)=>!!job&&job.status==='completed'&&job.outcome==='transcribed'&&!!job.transcript;
/** Cancellation can acknowledge an abort while the native child is still exiting. */
export async function settleCancelledStart(pending:EditorJob|Promise<EditorJob>,cancel:(id:string)=>Promise<{job:EditorJob}>){
  const started=await pending,{job}=await cancel(started.id);return {job,state:transcriptionJobPhase(job)};
}
