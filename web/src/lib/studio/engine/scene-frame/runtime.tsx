// The runtime inside a code scene's locked frame (protocol.ts): React, Remotion and the kit, bundled into one script
// (build.ts) that the frame's bootstrap adds when the host sends `boot`. It takes the scene's compiled module
// (CommonJS, its imports limited to react, remotion and @studio/kit), draws the frame the host asks for with
// Remotion's Thumbnail on a 1920-wide stage scaled into the layer's box, and answers `painted n` once that frame,
// its fonts and its images are on screen. Nothing here can reach the network: the frame's policy refuses every
// request, and the few browser features that could still reach out (WebRTC and the like) are taken away before the
// scene's code runs.
import * as React from 'react';
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as remotion from 'remotion';
import { Thumbnail } from '@remotion/player';
import * as kit from './kit';
import { SceneContext, type SceneInfo } from './kit';
import { MAX_ASSETS, MAX_ERROR_CHARS, MAX_FONT_FACES, NS, SCENE_IMAGE_TYPES, readInMessage, type FrameRequest, type InMessage, type OutMessage, type SceneAsset } from './protocol';

/** The modules a scene may import, by name. */
const MODULES: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxRuntime, remotion, '@studio/kit': kit };

const host = window.parent;
/** Tell the outer frame something (it passes on only the four known shapes). */
const send = (message: OutMessage) => host.postMessage(message, '*');
const say = (text: string) => send({ ns: NS, type: 'error', text: text.slice(0, MAX_ERROR_CHARS) });
const describe = (error: unknown) => error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : String(error);

/**
 * Take away what could still reach outside despite the policy (WebRTC's peer connections, workers, sockets, beacons,
 * window.open), before the scene's code runs. The policy is the wall; this is a second fence.
 */
function closeDoors(): string[] {
  const gone = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCRtpSender', 'WebTransport', 'WebSocket', 'WebSocketStream', 'EventSource',
    'XMLHttpRequest', 'fetch', 'fetchLater', 'Worker', 'SharedWorker', 'BroadcastChannel', 'open', 'importScripts', 'PresentationRequest'];
  for (const name of gone) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch { /* checked below */ }
  }
  try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: false, writable: false }); } catch { /* checked below */ }
  // The frame shares the page's session history: in WebKit a sandboxed frame's history.back() moves the page itself.
  const moves: [object | undefined, string, string[]][] = [[history, 'history', ['back', 'forward', 'go']], [(window as unknown as { navigation?: object }).navigation, 'navigation', ['back', 'forward', 'traverseTo', 'navigate', 'reload']]];
  for (const [target, , names] of moves) for (const name of names) {
    try { if (target) Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false }); } catch { /* checked below */ }
  }
  // A door a browser would not let us shut (WebRTC above all, which no policy covers) means no scene runs here.
  const open = gone.filter(name => (window as unknown as Record<string, unknown>)[name] !== undefined);
  if ((navigator as unknown as Record<string, unknown>).sendBeacon !== undefined) open.push('navigator.sendBeacon');
  for (const [target, label, names] of moves) for (const name of names) if (target && (target as Record<string, unknown>)[name] !== undefined) open.push(`${label}.${name}`);
  return open;
}

/** The scene's module, once its script has run. */
type SceneModule = { default?: React.ComponentType<Record<string, unknown>> };
let scene: SceneModule | null = null;

/** A scene's `require`: only the modules above. */
function requireModule(name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(MODULES, name)) return MODULES[name];
  throw new Error(`Scenes can import only react, remotion and @studio/kit (not "${name}")`);
}

// ---- images the scene asked for --------------------------------------------------------------------------------

/** Images by the name the scene used: a blob: address, or null when the host had none. */
const assets = new Map<string, { url: string; width?: number; height?: number } | null>();
const asked = new Set<string>();
let assetsVersion = 0;
const listeners = new Set<() => void>();
const changed = () => { assetsVersion++; for (const listener of listeners) listener(); };

/** The image a scene names, or null (and ask the host for it once). */
function assetFor(name: string) {
  if (assets.has(name)) { const found = assets.get(name); return found ? { url: found.url, kind: 'image' as const, width: found.width, height: found.height } : null; }
  if (!asked.has(name) && asked.size < MAX_ASSETS) { asked.add(name); send({ ns: NS, type: 'need', name }); }
  return null;
}
/** Names asked for and not answered yet. */
const waiting = () => [...asked].filter(name => !assets.has(name)).length;

function takeAssets(items: SceneAsset[]) {
  for (const item of items.slice(0, MAX_ASSETS)) {
    if (!item || typeof item.name !== 'string') continue;
    if (item.kind === 'image' && item.bytes instanceof ArrayBuffer && (SCENE_IMAGE_TYPES as readonly string[]).includes(item.type)) {
      assets.set(item.name, { url: URL.createObjectURL(new Blob([item.bytes], { type: item.type })), width: item.width, height: item.height });
    } else assets.set(item.name, null);
  }
  changed();
}

async function takeFonts(faces: { family: string; weight: string; style: 'normal' | 'italic'; bytes: ArrayBuffer }[]) {
  for (const face of faces.slice(0, MAX_FONT_FACES)) {
    if (!face || typeof face.family !== 'string' || !(face.bytes instanceof ArrayBuffer)) continue;
    try {
      const loaded = await new FontFace(face.family, face.bytes, { weight: face.weight, style: face.style }).load();
      document.fonts.add(loaded);
    } catch { /* a face that does not load falls back to the stack */ }
  }
  changed();
}

// ---- drawing -----------------------------------------------------------------------------------------------------

class Boundary extends Component<{ children: ReactNode; onError: (text: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(describe(error)); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Wait until every image on the page has decoded, the fonts are ready and two frames have been drawn. */
async function settled() {
  await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : image.decode().catch(() => undefined)));
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

let current: FrameRequest | null = null;
let setRequest: ((request: FrameRequest) => void) | null = null;

/** Draws the latest request, and answers `painted n` once it (and anything it asked for) is on screen. */
function Stage() {
  const [request, set] = useState<FrameRequest | null>(current);
  const [version, setVersion] = useState(assetsVersion);
  useEffect(() => { setRequest = set; if (current) set(current); return () => { setRequest = null; }; }, []);
  useEffect(() => { const listener = () => setVersion(assetsVersion); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const info = useMemo<SceneInfo | null>(() => request ? { width: request.stageWidth, height: request.stageHeight, seconds: request.durationInFrames / request.fps, asset: assetFor } : null,
    // A new set of images makes a new context, so Media looks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [request?.stageWidth, request?.stageHeight, request?.durationInFrames, request?.fps, version]);
  useEffect(() => {
    if (!request) return;
    let alive = true;
    // Answer only once nothing the scene asked for is still on its way (the answer re-renders this).
    if (waiting() > 0) return;
    void settled().then(() => { if (alive && current?.n === request.n) send({ ns: NS, type: 'painted', n: request.n }); });
    return () => { alive = false; };
  }, [request, version]);
  if (!request || !info || !scene?.default) return null;
  const scale = request.viewWidth / request.stageWidth;
  return <div style={{ position: 'absolute', left: 0, top: 0, width: request.stageWidth, height: request.stageHeight, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
    <SceneContext.Provider value={info}>
      <Boundary onError={say}>
        <Thumbnail component={scene.default} frameToDisplay={Math.max(0, Math.min(request.durationInFrames - 1, Math.round(request.frame)))} durationInFrames={Math.max(1, request.durationInFrames)}
          fps={request.fps} compositionWidth={request.stageWidth} compositionHeight={Math.max(1, Math.round(request.stageHeight))} inputProps={request.props}
          style={{ width: request.stageWidth, height: request.stageHeight }} overflowVisible noSuspense errorFallback={({ error }) => { say(describe(error)); return null; }} />
      </Boundary>
    </SceneContext.Provider>
  </div>;
}

// ---- the frame's side of the protocol ----------------------------------------------------------------------------

function receive(data: unknown) {
  const message: InMessage | null = readInMessage(data);
  if (!message) return;
  if (message.type === 'frame') { current = message; setRequest?.(message); }
  else if (message.type === 'assets') takeAssets(message.items);
  else if (message.type === 'fonts') void takeFonts(message.faces);
}

/** Run by the scene's own script (protocol.ts sceneScript): its module, given only the allowed modules. */
function define(factory: (load: (name: string) => unknown, exports: Record<string, unknown>, module: { exports: Record<string, unknown> }) => void) {
  if (scene) return;
  if (stillOpen.length) { say(`This browser would not let the scene frame shut ${stillOpen.join(', ')}, so the scene does not run here.`); return; }
  const made = { exports: {} as Record<string, unknown> };
  try {
    factory(requireModule, made.exports, made);
    scene = made.exports as SceneModule;
    if (typeof scene?.default !== 'function' && typeof scene?.default !== 'object') say('The scene has no default export: export default function Scene() { … }');
  } catch (error) { say(describe(error)); }
  if (current) setRequest?.(current);
}

addEventListener('error', event => say(describe(event.error ?? event.message)));
addEventListener('unhandledrejection', event => say(describe(event.reason)));
const stillOpen = closeDoors();
Object.defineProperty(window, '__studioSceneFrame', { value: Object.freeze({ define, receive }), configurable: false, writable: false });
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
const mount = document.createElement('div');
mount.style.cssText = 'position:absolute;inset:0;overflow:hidden';
document.body.appendChild(mount);
createRoot(mount).render(<Stage />);
