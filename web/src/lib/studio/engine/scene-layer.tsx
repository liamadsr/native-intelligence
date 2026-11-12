// Playing a code scene inside the composition: load its script once (a render waits for it), give it the shared
// React / Remotion / kit, a 1920-wide stage scaled to the layer, its own clock (frame 0 = the layer's start) and an
// error boundary that draws the error instead of breaking the film.
import React, { Component, useEffect, useState, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as remotion from 'remotion';
import { Sequence, continueRender, delayRender } from 'remotion';
import * as kit from './scene-kit';
import { SceneContext } from './scene-kit';
import type { EditorProject } from './contracts';
import type { EditorLayer } from './layers';

const g = globalThis as unknown as { __studio?: unknown; __studioScenes?: Record<string, { default?: React.ComponentType<any> }> };
g.__studio = { React, jsxRuntime, remotion, kit };
const loading = new Map<string, Promise<{ default?: React.ComponentType<any> }>>();
function load(id: string, url: string) {
  let p = loading.get(id);
  if (!p) {
    p = fetch(url).then(r => { if (!r.ok) throw new Error(`Scene ${id} is missing (${r.status})`); return r.text(); })
      .then(code => { new Function(code)(); const mod = g.__studioScenes?.[id]; if (!mod) throw new Error(`Scene ${id} did not register`); return mod; });
    loading.set(id, p); p.catch(() => loading.delete(id));
  }
  return p;
}
function useSceneModule(id: string, url: string) {
  const [state, setState] = useState<{ mod?: { default?: React.ComponentType<any> }; error?: string }>(() => ({ mod: g.__studioScenes?.[id] }));
  const [handle] = useState(() => (g.__studioScenes?.[id] ? null : delayRender(`Loading scene ${id}`)));
  useEffect(() => {
    if (state.mod) { if (handle !== null) continueRender(handle); return; }
    let alive = true;
    load(id, url).then(mod => { if (alive) setState({ mod }); }).catch(e => { if (alive) setState({ error: e instanceof Error ? e.message : String(e) }); }).finally(() => { if (handle !== null) continueRender(handle); });
    return () => { alive = false; };
  }, [id]);
  return state;
}

class SceneBoundary extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e) }; }
  render() { return this.state.error ? <SceneProblem name={this.props.name} text={this.state.error} /> : this.props.children; }
}
const SceneProblem = ({ name, text }: { name: string; text: string }) => <div style={{ position: 'absolute', left: 40, top: 40, right: 40, padding: 24, borderRadius: 14, background: 'rgba(30,6,6,.88)', color: '#ffb4ab', font: '500 22px/1.4 ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap' }}>Scene “{name}” failed:{'\n'}{text}</div>;

export const STAGE_WIDTH = 1920;
export function CodeLayer({ layer, project, assetPath, common, width, height, fps }: { layer: EditorLayer; project: EditorProject; assetPath: (file: string) => string; common: React.CSSProperties; width: number; height: number; fps: number }) {
  const scene = layer.style.scene!, { mod, error } = useSceneModule(scene.id, assetPath(`scenes/${scene.id}.js`));
  const boxW = layer.width * width, boxH = layer.height * height, scale = boxW / STAGE_WIDTH, stageH = boxH / scale;
  const info = { width: STAGE_WIDTH, height: stageH, seconds: (layer.endFrame - layer.startFrame) / fps,
    asset: (key: string) => { const a = project.assets.find(x => x.id === key || x.name === key || x.name.replace(/\.[^.]+$/, '') === key); return a ? { url: assetPath(a.file), kind: a.kind as 'image' | 'video' | 'audio', width: a.width, height: a.height } : null; } };
  const Scene = mod?.default;
  return <div style={{ ...common, width: boxW, height: boxH }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: STAGE_WIDTH, height: stageH, transform: `scale(${scale})`, transformOrigin: '0 0', overflow: layer.style.clip ? 'hidden' : 'visible' }}>
      <SceneContext.Provider value={info}>
        <Sequence from={layer.startFrame} durationInFrames={Math.max(1, layer.endFrame - layer.startFrame)} layout="none">
          <SceneBoundary name={scene.name}>{error ? <SceneProblem name={scene.name} text={error} /> : Scene ? <Scene {...(scene.props ?? {})} /> : null}</SceneBoundary>
        </Sequence>
      </SceneContext.Provider>
    </div>
  </div>;
}
