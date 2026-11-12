import type { EditorProject } from '@/lib/studio/engine/contracts';

/** Explicit choices survive ordinary edits; Undo may remove an imported source. */
export function transcriptSource(project: EditorProject, chosen: string | null, selectedClipIds: string[]): string {
  const eligible = (id: string | undefined) => project.assets.some(asset => asset.id === id && asset.kind !== 'image');
  if (chosen && eligible(chosen)) return chosen;
  const selected = project.clips.find(clip => selectedClipIds.includes(clip.id))?.assetId;
  if (eligible(selected)) return selected!;
  const firstClip = project.clips[0]?.assetId;
  if (eligible(firstClip)) return firstClip!;
  return project.assets.find(asset => asset.kind !== 'image')?.id ?? '';
}
