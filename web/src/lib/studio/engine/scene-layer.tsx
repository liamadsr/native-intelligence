// Playing a code scene inside the composition. The scene's code never runs in this page: the layer holds a locked
// frame (scene-frame/protocol.ts) in its box, sends it the compiled scene once and then, for each frame, the frame
// number and the props, and the frame answers when that frame is painted. In the editor's preview the frame keeps up
// as it can; in a render (an export, stills, a check) each frame waits for it (delayRender), and a scene that fails or
// does not draw in time fails the render with a sentence naming it. The same layer, runtime and frame in both.
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useRemotionEnvironment } from 'remotion';
import type { EditorProject } from './contracts';
import type { EditorLayer } from './layers';
import { FRAME_SANDBOX, STAGE_WIDTH, SCENE_IMAGE_TYPES, type SceneAsset, type SceneFontFace } from './scene-frame/protocol';
import { SceneHost } from './scene-frame/host';
import type { FontFace } from './font-names';

export { STAGE_WIDTH };

/** Where the app serves the frame runtime (web/scripts/studio-scene-runtime.mjs); a render bundle has it in its public folder. */
export const RUNTIME_FILE = 'studio-scene/frame-runtime.js';

/**
 * How code scenes draw in this composition: `run` (in their locked frame) or `placeholder` (a labelled box, their
 * code never loaded: a thumbnail, a sound-only render, or a worker where code scenes are off), and the font faces
 * the composition has, so a scene's families can be handed to its frame as bytes.
 */
export type CodeScenes = { mode: 'run' | 'placeholder'; fonts?: FontFace[] };
export const CodeScenesContext = createContext<CodeScenes>({ mode: 'run' });

/** The image type of a library file by its name (the frame takes only these). Pure. */
export function imageTypeOf(file: string): string | null {
  const ext = file.toLowerCase().split('.').pop();
  const type = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : null;
  return type && (SCENE_IMAGE_TYPES as readonly string[]).includes(type) ? type : null;
}

/** The library image a scene names (by id, name, or name without its extension), or undefined. Pure. */
export function findSceneImage(project: EditorProject, name: string) {
  return project.assets.find(a => a.kind === 'image' && (a.id === name || a.name === name || a.name.replace(/\.[^.]+$/, '') === name));
}

const SceneProblem = ({ name, text }: { name: string; text: string }) => <div style={{ position: 'absolute', left: 40, top: 40, right: 40, padding: 24, borderRadius: 14, background: 'rgba(30,6,6,.88)', color: '#ffb4ab', font: '500 22px/1.4 ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap' }}>Scene “{name}” failed:{'\n'}{text}</div>;
const ScenePlaceholder = ({ name }: { name: string }) => <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-linear-gradient(45deg,rgba(120,120,140,.28) 0 14px,rgba(120,120,140,.16) 14px 28px)', color: '#fff', font: '600 28px sans-serif', textShadow: '0 1px 3px rgba(0,0,0,.5)' }}>Code scene · {name}</div>;

export function CodeLayer({ layer, project, assetPath, common, width, height, fps }: { layer: EditorLayer; project: EditorProject; assetPath: (file: string) => string; common: React.CSSProperties; width: number; height: number; fps: number }) {
  const scene = layer.style.scene!, mode = useContext(CodeScenesContext).mode;
  const boxW = layer.width * width, boxH = layer.height * height;
  return <div style={{ ...common, width: boxW, height: boxH }}>
    {mode === 'placeholder' ? <ScenePlaceholder name={scene.name} /> : <SceneFrame layer={layer} project={project} assetPath={assetPath} boxW={boxW} boxH={boxH} fps={fps} />}
  </div>;
}

/** The scene's frame in the layer's box, kept in step with the composition's frame. */
function SceneFrame({ layer, project, assetPath, boxW, boxH, fps }: { layer: EditorLayer; project: EditorProject; assetPath: (file: string) => string; boxW: number; boxH: number; fps: number }) {
  const scene = layer.style.scene!, environment = useRemotionEnvironment(), rendering = environment.isRendering, fonts = useContext(CodeScenesContext).fonts;
  const iframe = useRef<HTMLIFrameElement>(null), [host, setHost] = useState<SceneHost | null>(null), [problem, setProblem] = useState<string | null>(null);
  // The latest project and fonts, for the frame's requests (the host lives as long as the scene's code does).
  const latest = useRef({ project, fonts }); latest.current = { project, fonts };
  const runtimeUrl = environment.isPlayer ? `/${RUNTIME_FILE}` : staticFile(RUNTIME_FILE), codeUrl = assetPath(`scenes/${scene.id}.js`);
  useLayoutEffect(() => {
    if (!iframe.current) return;
    const made = new SceneHost(iframe.current, {
      name: scene.name, runtimeUrl, codeUrl, onError: setProblem,
      image: name => imageBytes(latest.current.project, name, assetPath),
      fonts: () => fontBytes(latest.current.fonts ?? [], scene.fonts ?? [], assetPath),
    });
    setHost(made); setProblem(null);
    return () => made.close();
    // A new scene (or a new address for its code) is a new frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id, codeUrl, runtimeUrl]);
  const frame = useCurrentFrame() - layer.startFrame, durationInFrames = Math.max(1, layer.endFrame - layer.startFrame);
  const stageHeight = boxH / (boxW / STAGE_WIDTH), propsKey = useMemo(() => JSON.stringify(scene.props ?? {}), [scene.props]);
  useLayoutEffect(() => {
    if (!host) return;
    const handle = rendering ? delayRender(`Code scene "${scene.name}", frame ${frame}`) : null;
    host.show({ frame, fps, durationInFrames, stageWidth: STAGE_WIDTH, stageHeight, viewWidth: boxW, viewHeight: boxH, props: JSON.parse(propsKey) as Record<string, unknown> })
      .then(() => { if (handle !== null) continueRender(handle); })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        if (handle !== null) cancelRender(new Error(text));
        else setProblem(text);
      });
  }, [host, frame, fps, durationInFrames, stageHeight, boxW, boxH, propsKey, rendering, scene.name]);
  return <>
    <iframe ref={iframe} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" title={`Code scene ${scene.name}`} aria-hidden="true" tabIndex={-1}
      style={{ position: 'absolute', left: 0, top: 0, width: boxW, height: boxH, border: 0, margin: 0, padding: 0, background: 'transparent', colorScheme: 'normal', pointerEvents: 'none', display: 'block' }} />
    {problem ? <SceneProblem name={scene.name} text={problem} /> : null}
  </>;
}

/** A library image's bytes for the frame (only the video's own images, never an address). */
async function imageBytes(project: EditorProject, name: string, assetPath: (file: string) => string): Promise<SceneAsset> {
  const asset = findSceneImage(project, name), type = asset ? imageTypeOf(asset.file) : null;
  if (!asset || !type) return { name, kind: 'missing' };
  const response = await fetch(assetPath(asset.file));
  if (!response.ok) return { name, kind: 'missing' };
  return { name, kind: 'image', type, bytes: await response.arrayBuffer(), width: asset.width, height: asset.height };
}

/** The faces of the families a scene names, as bytes (a face that cannot be fetched is left out). */
async function fontBytes(faces: FontFace[], families: string[], assetPath: (file: string) => string): Promise<SceneFontFace[]> {
  const wanted = new Set(families.map(f => f.toLowerCase()));
  const out: SceneFontFace[] = [];
  for (const face of faces.filter(f => wanted.has(f.family.toLowerCase())).slice(0, 16)) {
    const response = await fetch(assetPath(face.file)).catch(() => null);
    if (response?.ok) out.push({ family: face.family, weight: face.weight, style: face.style, bytes: await response.arrayBuffer() });
  }
  return out;
}
