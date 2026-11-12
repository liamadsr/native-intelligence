/**
 * The code scene frame's protocol (../protocol.ts): the four shapes a host reads from a frame (anything else is
 * dropped), the one policy both frames carry (no requests of any kind, scripts only by hash), and the frame document
 * whose policy lists exactly the relay, the bootstrap, the runtime and the scene.
 */
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP, FRAME_SANDBOX, MAX_ERROR_CHARS, NS, frameDocument, framePolicy, readInMessage, readOutMessage, relayScript, sceneScript, scriptHash } from '../protocol'

describe("what a host reads from a frame", () => {
  it('takes only ready, painted n, need name and error text, from its namespace', () => {
    expect(readOutMessage({ ns: NS, type: 'ready', extra: 'x' })).toEqual({ ns: NS, type: 'ready' })
    expect(readOutMessage({ ns: NS, type: 'painted', n: 3 })).toEqual({ ns: NS, type: 'painted', n: 3 })
    expect(readOutMessage({ ns: NS, type: 'need', name: 'logo.png' })).toEqual({ ns: NS, type: 'need', name: 'logo.png' })
    expect(readOutMessage({ ns: NS, type: 'error', text: 'x'.repeat(MAX_ERROR_CHARS + 50) })).toEqual({ ns: NS, type: 'error', text: 'x'.repeat(MAX_ERROR_CHARS) })
    for (const bad of [null, 'ready', { type: 'ready' }, { ns: 'other', type: 'ready' }, { ns: NS, type: 'painted', n: -1 }, { ns: NS, type: 'painted', n: '3' }, { ns: NS, type: 'painted', n: 1.5 },
      { ns: NS, type: 'need', name: '' }, { ns: NS, type: 'need', name: 'x'.repeat(201) }, { ns: NS, type: 'error', text: 5 }, { ns: NS, type: 'boot', runtime: '', scene: '' }, { ns: NS, type: 'navigate', url: 'https://x' }, [NS]])
      expect(readOutMessage(bad), JSON.stringify(bad)).toBeNull()
  })

  it('the frame takes boot, frame, assets and fonts', () => {
    expect(readInMessage({ ns: NS, type: 'frame', n: 1, frame: 4, fps: 30, props: {} })).not.toBeNull()
    expect(readInMessage({ ns: NS, type: 'frame', n: 1, frame: 4, fps: 30, props: [] })).toBeNull()
    expect(readInMessage({ ns: NS, type: 'boot', runtime: 'a', scene: 'b' })).not.toBeNull()
    expect(readInMessage({ ns: NS, type: 'assets', items: [] })).not.toBeNull()
    expect(readInMessage({ ns: 'x', type: 'assets', items: [] })).toBeNull()
  })
})

describe('the frame policy and documents', () => {
  it('refuses every request and lists scripts only by hash', () => {
    const policy = framePolicy(['sha256-abc', 'sha256-def'])
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "manifest-src 'none'", 'img-src data: blob:', 'font-src data: blob:', 'media-src data: blob:'])
      expect(policy).toContain(directive)
    expect(policy).toContain("script-src 'sha256-abc' 'sha256-def'")
    const scripts = policy.split('; ').find((d) => d.startsWith('script-src'))!
    expect(scripts).not.toMatch(/unsafe|https?:|\*|self/)
    expect(policy).not.toMatch(/https?:|\*|'self'/)
    expect(FRAME_SANDBOX).toBe('allow-scripts')
  })

  it("the frame document's policy names the relay, the bootstrap, the runtime and the scene, and the relay holds the inner document", async () => {
    const runtime = 'window.runtime = 1;'
    const scene = sceneScript('exports.default = function S() { return null; };')
    const doc = await frameDocument(runtime, scene)
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(doc)![1]!
    const relay = /<script>([\s\S]*)<\/script>/.exec(doc)![1]!
    const hashes = await Promise.all([relay, BOOTSTRAP, runtime, scene].map(scriptHash))
    for (const hash of hashes) expect(policy).toContain(`'${hash}'`)
    expect((policy.match(/'sha256-/g) ?? []).length).toBe(4)
    // The inner document rides inside the relay as a string: no tag in it can end the relay's script.
    expect(relay).not.toMatch(/<\/script/i)
    expect(relay).toContain('allow-scripts')
    expect(relayScript(framePolicy([]))).toContain('\\u003c!doctype html>')
  })

  it("puts the scene's code on the wrapper's first line, so its lines are the scene's", () => {
    expect(sceneScript('a();\nb();').split('\n')[0]).toMatch(/define\(function \(require, exports, module\) \{a\(\);$/)
  })
})
