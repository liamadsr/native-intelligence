import { EditorProjectSchema,type EditorProject } from '@/lib/studio/engine/contracts';
import { deleteTranscriptWords,transcriptWords,type TranscriptRow } from '@/lib/studio/engine/transcript';
export type WordSelection={ids:string[];anchor:string|null};
export function selectTimedWord(rows:readonly {id:string}[],selection:WordSelection,id:string,multiple:boolean,range:boolean):WordSelection{
  const index=rows.findIndex(row=>row.id===id);if(index<0)return selection;
  const anchor=rows.findIndex(row=>row.id===selection.anchor);
  if(range&&anchor>=0)return {ids:rows.slice(Math.min(index,anchor),Math.max(index,anchor)+1).map(row=>row.id),anchor:selection.anchor};
  return {ids:multiple?(selection.ids.includes(id)?selection.ids.filter(value=>value!==id):[...selection.ids,id]):[id],anchor:id};
}
export function cutSelectedWords(project:EditorProject,ids:string[]):EditorProject{
  const current=transcriptWords(project).filter(row=>ids.includes(row.id));
  if(!current.length||current.length!==new Set(ids).size)throw new Error('The word selection changed. Select the current timed words again.');
  if(current.some(row=>!row.timingReliable))throw new Error('Selected words have incomplete timing. Retranscribe this source before making word cuts.');
  return EditorProjectSchema.parse(deleteTranscriptWords(project,ids));
}
export function uncertainPointGroups(rows:readonly TranscriptRow[]):Map<string,TranscriptRow[]>{
  const result=new Map<string,TranscriptRow[]>();for(const row of rows.filter(row=>!row.timingReliable)){const key=`${row.instanceId}:${row.transcriptId}:${row.startFrame}`,group=result.get(key)??[];group.push(row);result.set(key,group);}return result;
}
