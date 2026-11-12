// The page's side of a code scene's locked frame (protocol.ts), without React: it fills the outer frame's document,
// boots the runtime and the scene in it, asks for frames and waits for each to be painted, answers the frame's
// requests for images (only the video's own library images, as bytes), and reads nothing from the frame but the
// four message shapes, and only from its own frame.
import { BOOT_TIMEOUT_MS, FRAME_TIMEOUT_MS, MAX_ASSET_BYTES, MAX_ASSETS, NS, frameDocument, readOutMessage, sceneScript, type FrameRequest, type SceneAsset, type SceneFontFace } from './protocol'

/** Text fetched once per address for the page's life (the runtime, a scene's compiled code). */
const texts = new Map<string, Promise<string>>()
export function fetchText(url: string, what: string): Promise<string> {
  let found = texts.get(url)
  if (!found) {
    found = fetch(url).then(response => { if (!response.ok) throw new Error(`${what} could not be loaded (${response.status})`); return response.text(); })
    texts.set(url, found)
    found.catch(() => texts.delete(url))
  }
  return found
}

export type HostOptions = {
  /** The scene's name, for the sentences a failure says. */
  name: string
  runtimeUrl: string
  codeUrl: string
  /** The bytes of a library image the scene names (by id or name), or null when there is none. */
  image: (name: string) => Promise<SceneAsset>
  /** The font files of the families the scene names. */
  fonts?: () => Promise<SceneFontFace[]>
  /** The frame said the scene failed. */
  onError: (text: string) => void
}

type Waiting = { n: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** One scene's frame, in one <iframe> the caller made and placed. */
export class SceneHost {
  private readonly frame: HTMLIFrameElement
  private readonly options: HostOptions
  private booted: Promise<void> | null = null
  private bootDone = false
  private readyFrame: (() => void) | null = null
  private waiting: Waiting | null = null
  private n = 0
  private failure: string | null = null
  private closed = false
  /** The image names already answered (or being answered). */
  private readonly answered = new Set<string>()
  private readonly listener = (event: MessageEvent) => this.onMessage(event)

  constructor(frame: HTMLIFrameElement, options: HostOptions) {
    this.frame = frame
    this.options = options
    window.addEventListener('message', this.listener)
  }

  /** Fill the frame and boot the runtime and the scene in it (once). */
  private boot(): Promise<void> {
    this.booted ??= (async () => {
      const [runtime, code] = await Promise.all([fetchText(this.options.runtimeUrl, 'The scene runtime'), fetchText(this.options.codeUrl, `The code of scene "${this.options.name}"`)])
      const scene = sceneScript(code)
      const ready = new Promise<void>(resolve => { this.readyFrame = resolve })
      this.frame.srcdoc = await frameDocument(runtime, scene)
      await ready
      this.post({ ns: NS, type: 'boot', runtime, scene })
      const faces = await this.options.fonts?.().catch(() => []) ?? []
      if (faces.length) this.post({ ns: NS, type: 'fonts', faces }, faces.map(face => face.bytes))
      this.bootDone = true
    })()
    return this.booted
  }

  private post(message: unknown, transfer: Transferable[] = []) {
    this.frame.contentWindow?.postMessage(message, '*', transfer)
  }

  /**
   * Show frame `request` (without its number): resolves when the frame has painted it, or when a newer request takes
   * its place; rejects when the scene failed or did not paint within the time (a sentence naming the scene).
   */
  show(request: Omit<FrameRequest, 'n'>): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.failure) return Promise.reject(new Error(this.failure))
    const n = ++this.n
    this.waiting?.resolve()
    const limit = this.bootDone ? FRAME_TIMEOUT_MS : BOOT_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(n, new Error(`The code scene "${this.options.name}" did not draw its frame ${request.frame} within ${Math.round(limit / 1000)} s.`)), limit)
      this.waiting = { n, resolve: () => { clearTimeout(timer); resolve() }, reject: (error) => { clearTimeout(timer); reject(error) }, timer }
      this.boot().then(() => { if (this.waiting?.n === n) this.post({ ns: NS, type: 'frame', n, ...request }) },
        error => this.settle(n, error instanceof Error ? error : new Error(String(error))))
    })
  }

  /** End request n: painted (no error) or failed. */
  private settle(n: number, error?: Error) {
    const waiting = this.waiting
    if (!waiting || waiting.n !== n) return
    this.waiting = null
    if (error) waiting.reject(error)
    else waiting.resolve()
  }

  private onMessage(event: MessageEvent) {
    if (this.closed || event.source !== this.frame.contentWindow) return
    const message = readOutMessage(event.data)
    if (!message) return
    if (message.type === 'ready') this.readyFrame?.()
    else if (message.type === 'painted') this.settle(message.n)
    else if (message.type === 'need') void this.answer(message.name)
    else {
      this.failure = `The code scene "${this.options.name}" failed: ${message.text}`
      this.options.onError(message.text)
      if (this.waiting) this.settle(this.waiting.n, new Error(this.failure))
    }
  }

  /**
   * Answer a request for an image with its bytes, or say it is missing. Each name once, and at most MAX_ASSETS names
   * (as many as the runtime ever asks for): a scene can post `need` to its relay itself, as often as it likes, and
   * each answer is a fetch and a copy of up to 25 MB in this page.
   */
  private async answer(name: string) {
    if (this.answered.has(name) || this.answered.size >= MAX_ASSETS) return
    this.answered.add(name)
    let item: SceneAsset
    try {
      item = await this.options.image(name)
      if (item.kind === 'image' && item.bytes.byteLength > MAX_ASSET_BYTES) item = { name, kind: 'missing' }
    } catch {
      item = { name, kind: 'missing' }
    }
    this.post({ ns: NS, type: 'assets', items: [item] }, item.kind === 'image' ? [item.bytes] : [])
  }

  /** Stop listening and let any wait go. */
  close() {
    this.closed = true
    window.removeEventListener('message', this.listener)
    this.waiting?.resolve()
    this.waiting = null
  }
}
