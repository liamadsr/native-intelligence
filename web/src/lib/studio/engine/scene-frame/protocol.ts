// The code scene's locked frame: the documents, their Content-Security-Policy and the messages that cross into and out
// of it. Pure (no React, no DOM until a function is called in a browser), shared by the layer that hosts a frame
// (../scene-layer.tsx), the runtime inside it (runtime.tsx) and the tests.
//
// A scene's code never runs in the page that shows it. The layer draws an <iframe sandbox="allow-scripts"> (never
// allow-same-origin: an opaque origin, so no cookies, no storage, no way into the page) whose document is the OUTER
// frame: our relay script and nothing else. The relay makes the INNER frame, sandboxed the same way, where the
// runtime (React, Remotion, the kit) and the scene's code run. Two frames because a frame may always navigate
// itself, and only its parent's `frame-src` can stop that: the outer document's policy says `frame-src 'none'`, so
// the inner frame can never load another address, and the outer one runs nothing but the relay.
//
// Both documents are `srcdoc` (nothing is fetched to make them) and carry one policy: no requests of any kind, and
// scripts only by hash (the relay, the bootstrap, the runtime and this scene's code, hashed by the layer), so the
// scene cannot add a script of its own, `eval` included. Images and fonts come in as bytes, never by address.
//
// Messages (every one a plain object with `ns: 'studio-scene'`):
//   into the frame:  boot {runtime, scene}         the runtime's and the scene's code, once
//                    frame {n, frame, …, props}    draw this frame, answer `painted n`
//                    assets {items}                the images the scene asked for, as bytes
//                    fonts {faces}                 font files the scene names, as bytes
//   out of it:       ready                         the frame is listening (send boot)
//                    painted {n}                   frame request n is on screen
//                    need {name}                   the scene asked for an image by id or name
//                    error {text}                  the scene failed (its message, at most 2000 characters)
// The host treats everything that comes out as untrusted: only these shapes, from its own frame, are read.

/** Every message carries this, so stray messages are ignored at once. */
export const NS = 'studio-scene'

/** The stage a scene draws on is this many px wide; its height follows the layer's box. */
export const STAGE_WIDTH = 1920

/** How long the frame may take to start and draw its first frame, and each later one, before the render fails. */
export const BOOT_TIMEOUT_MS = 30_000
export const FRAME_TIMEOUT_MS = 15_000

/** What a scene may ask for, and how much. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024
export const MAX_ASSETS = 24
export const MAX_FONT_FACES = 16
export const MAX_ERROR_CHARS = 2000
export const MAX_NAME_CHARS = 200

/** The image types a scene can be handed (the Studio's own still images). */
export const SCENE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type FrameRequest = {
  /** Request number: `painted` names it. */
  n: number
  /** The scene's own frame (0 = the layer's start). */
  frame: number
  fps: number
  durationInFrames: number
  /** The stage (1920 wide) and the box it is drawn into (px of the composition). */
  stageWidth: number
  stageHeight: number
  viewWidth: number
  viewHeight: number
  props: Record<string, unknown>
}
export type SceneAsset = { name: string; kind: 'image'; type: string; bytes: ArrayBuffer; width?: number; height?: number } | { name: string; kind: 'missing' }
export type SceneFontFace = { family: string; weight: string; style: 'normal' | 'italic'; bytes: ArrayBuffer }

export type InMessage =
  | { ns: typeof NS; type: 'boot'; runtime: string; scene: string }
  | ({ ns: typeof NS; type: 'frame' } & FrameRequest)
  | { ns: typeof NS; type: 'assets'; items: SceneAsset[] }
  | { ns: typeof NS; type: 'fonts'; faces: SceneFontFace[] }
export type OutMessage =
  | { ns: typeof NS; type: 'ready' }
  | { ns: typeof NS; type: 'painted'; n: number }
  | { ns: typeof NS; type: 'need'; name: string }
  | { ns: typeof NS; type: 'error'; text: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A message from a frame, if it has one of the four shapes (anything else is null). Only plain values are read:
 * a number for `painted`, a short string for `need` and `error`. Pure.
 */
export function readOutMessage(data: unknown): OutMessage | null {
  if (!isObject(data) || data.ns !== NS) return null
  if (data.type === 'ready') return { ns: NS, type: 'ready' }
  if (data.type === 'painted' && Number.isSafeInteger(data.n) && (data.n as number) >= 0) return { ns: NS, type: 'painted', n: data.n as number }
  if (data.type === 'need' && typeof data.name === 'string' && data.name.length > 0 && data.name.length <= MAX_NAME_CHARS) return { ns: NS, type: 'need', name: data.name }
  if (data.type === 'error' && typeof data.text === 'string') return { ns: NS, type: 'error', text: data.text.slice(0, MAX_ERROR_CHARS) }
  return null
}

/** A message into a frame, by its type (the runtime's side of the check). Pure. */
export function readInMessage(data: unknown): InMessage | null {
  if (!isObject(data) || data.ns !== NS) return null
  if (data.type === 'boot' && typeof data.runtime === 'string' && typeof data.scene === 'string') return data as InMessage
  if (data.type === 'frame' && Number.isSafeInteger(data.n) && Number.isFinite(data.frame) && Number.isFinite(data.fps) && isObject(data.props)) return data as InMessage
  if (data.type === 'assets' && Array.isArray(data.items)) return data as InMessage
  if (data.type === 'fonts' && Array.isArray(data.faces)) return data as InMessage
  return null
}

// ---- the documents ----------------------------------------------------------------------------------------------

/**
 * The inner frame's bootstrap: tell the outer frame it listens, then on `boot` add the runtime and the scene as
 * scripts (their hashes are in the policy; nothing else may run), and hand every later message to the runtime.
 */
export const BOOTSTRAP = `(function(){var booted=false;function add(text){var s=document.createElement('script');s.textContent=text;document.head.appendChild(s);}
addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.ns!=='${NS}')return;
if(d.type==='boot'){if(booted)return;booted=true;add(d.runtime);add(d.scene);return;}
var r=window.__studioSceneFrame;if(r)r.receive(d);});
parent.postMessage({ns:'${NS}',type:'ready'},'*');})();`

/** The inner document: the policy, a transparent page, the bootstrap. */
export function innerDocument(policy: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="color-scheme" content="normal"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}</style></head><body><script>${BOOTSTRAP}</script></body></html>`
}

/**
 * The outer frame's relay: make the inner frame (sandboxed, transparent, filling the box), pass the host's messages
 * in (queued until the inner frame is listening) and the inner frame's out (only well-formed ones, as plain values).
 * `INNER` is replaced with the inner document as a JSON string.
 */
export const RELAY = `(function(){var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.setAttribute('referrerpolicy','no-referrer');
f.style.cssText='border:0;margin:0;padding:0;display:block;width:100%;height:100%;background:transparent;color-scheme:normal';f.srcdoc=INNER;document.body.appendChild(f);
var open=false,queue=[];function inner(){return f.contentWindow;}
addEventListener('message',function(e){var d=e.data;if(!d||d.ns!=='${NS}')return;
if(e.source===parent){if(open)inner().postMessage(d,'*');else queue.push(d);return;}
if(e.source!==inner())return;var out=null;
if(d.type==='ready'){out={ns:'${NS}',type:'ready'};open=true;for(var i=0;i<queue.length;i++)inner().postMessage(queue[i],'*');queue=[];}
else if(d.type==='painted'&&typeof d.n==='number')out={ns:'${NS}',type:'painted',n:d.n};
else if(d.type==='need'&&typeof d.name==='string')out={ns:'${NS}',type:'need',name:d.name.slice(0,${MAX_NAME_CHARS})};
else if(d.type==='error'&&typeof d.text==='string')out={ns:'${NS}',type:'error',text:d.text.slice(0,${MAX_ERROR_CHARS})};
if(out)parent.postMessage(out,'*');});})();`

/** The relay with the inner document in it. Pure. */
export function relayScript(policy: string): string {
  const inner = JSON.stringify(innerDocument(policy)).replace(/</g, '\\u003c')
  return RELAY.replace('INNER', () => inner)
}

/**
 * The one policy both frames carry. No request of any kind (fetch, XHR, WebSocket, beacon, image, font, media,
 * frame, worker, form, prefetch, manifest); images, media and fonts only from data: and blob: (bytes the host
 * handed in); styles inline; scripts only the ones whose hashes are listed (no 'unsafe-inline', no 'unsafe-eval').
 * Pure.
 */
export function framePolicy(scriptHashes: string[]): string {
  return [
    "default-src 'none'",
    `script-src ${scriptHashes.map((hash) => `'${hash}'`).join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** The scene's code as the frame runs it: the compiled module (CommonJS), handed its own `require`. Pure. */
export function sceneScript(code: string): string {
  // On the first line, so a line in an error is the scene's own line.
  return `window.__studioSceneFrame.define(function (require, exports, module) {${code}\n});`
}

/** A script's CSP hash (`sha256-<base64>`), with the platform's Web Crypto (browsers and Node). */
export async function scriptHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return `sha256-${btoa(binary)}`
}

/**
 * The outer frame's document for a runtime and a scene: the policy lists exactly the relay, the bootstrap, the
 * runtime and the scene. The relay's own hash depends on the policy inside it, so the relay is hashed with a policy
 * that names the other three, and the final policy adds it.
 */
export async function frameDocument(runtime: string, scene: string): Promise<string> {
  const base = await Promise.all([scriptHash(BOOTSTRAP), scriptHash(runtime), scriptHash(scene)])
  // The relay carries the inner document, so the inner policy is the three without the relay (the inner frame never
  // runs it), and the outer document's policy adds the relay's hash.
  const innerPolicy = framePolicy(base)
  const relay = relayScript(innerPolicy)
  const outerPolicy = framePolicy([await scriptHash(relay), ...base])
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${outerPolicy}"><meta name="color-scheme" content="normal"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}</style></head><body><script>${relay}</script></body></html>`
}

/** The sandbox both frames get: scripts, nothing else (no same origin, forms, popups, top navigation, downloads). */
export const FRAME_SANDBOX = 'allow-scripts'
