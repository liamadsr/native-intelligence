import { createContext, useContext } from 'react';
import type { EditorAsset, EditorProject } from './contracts';

/**
 * The composition draws the picture twice when a project has subject cut-outs: once normally, then — above the layers
 * marked `behind` — again with every recording swapped for its transparent cut-out (and everything else left out),
 * so the speaker ends up in front of the words. Same components, same geometry: the cut-out lines up by construction.
 */
export const CutoutPass = createContext(false);
export const useCutoutPass = () => useContext(CutoutPass);

/** What to play for `asset` in this pass: the recording itself, its cut-out, or nothing (no cut-out in the cut-out pass). */
export function passAsset(project: EditorProject, asset: EditorAsset, cutoutPass: boolean): EditorAsset | null {
  if (!cutoutPass) return asset;
  const cut = project.cutouts?.find(item => item.assetId === asset.id);
  return cut ? project.assets.find(item => item.id === cut.cutoutAssetId) ?? null : null;
}

/** CSS filter for the colour grade automation (saturation / contrast) at a timeline frame. */
export function gradeFilter(saturation: number, contrast: number) {
  return [Math.abs(saturation - 1) > 0.005 ? `saturate(${saturation.toFixed(3)})` : '', Math.abs(contrast - 1) > 0.005 ? `contrast(${contrast.toFixed(3)})` : ''].filter(Boolean).join(' ');
}
