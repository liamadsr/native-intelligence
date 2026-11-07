import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The capture's controls live at the foot of its own card (CaptureControlsBar,
 * one-chat Slice 3), never in the chat composer, which is the main agent's.
 * Built inside WindowProperties, they'd live and die with the preferences
 * popover (or its standalone sidebar fallback). Closing preferences must not
 * remove them, just as narrowing the old sidebar must not.
 *
 * CaptureDetailPanel can't be mounted in a unit test (it drags in the editor
 * stack — see detail-step-prefetch.test.ts), so this pins the placement in the
 * source, the way campaigns-view-wiring.test.ts checks a render branch.
 */

const source = readFileSync(
  join(process.cwd(), 'src/app/account/(dashboard)/views/capture-detail-panel.tsx'),
  'utf8',
)
const file = ts.createSourceFile(
  'capture-detail-panel.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

/** The flags the sidebar's visibility flows through in CaptureDetailPanel. */
const SIDEBAR_FLAGS = new Set(['sidebarMounted', 'sidebarOpen'])

function elementsNamed(tag: string): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(file) === tag
    ) {
      found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function mentionsSidebarFlag(expr: ts.Node): boolean {
  if (ts.isIdentifier(expr) && SIDEBAR_FLAGS.has(expr.text)) return true
  return ts.forEachChild(expr, (child) => mentionsSidebarFlag(child) || undefined) ?? false
}

/** The properties host, or a legacy conditional that gates sidebar content. */
function propertiesGate(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(file) === 'WindowProperties') {
      return n
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      mentionsSidebarFlag(n.left)
    ) {
      return n
    }
    if (ts.isConditionalExpression(n) && mentionsSidebarFlag(n.condition)) return n
  }
  return undefined
}

describe('where CaptureDetailPanel builds the Live Agent controls', () => {
  it('builds them exactly once, on the card: no composer portal, no pinned card', () => {
    expect(elementsNamed('CaptureControlsBar')).toHaveLength(1)
    expect(elementsNamed('LiveAgentComposerPortal')).toHaveLength(0)
    expect(elementsNamed('FloatingLiveAgentPanel')).toHaveLength(0)
    expect(source).not.toContain('composer-capture-slots')
  })

  it('builds them outside the preferences popover and sidebar visibility gates', () => {
    const [portal] = elementsNamed('CaptureControlsBar')
    expect(propertiesGate(portal)?.getText(file).slice(0, 40)).toBeUndefined()
  })

  it('puts every control on the card', () => {
    // Voice ID above the top row; the agent picker in it, and Transcripts and
    // Tools (LiveCapturePills) beside Capture. (What each does is the leaves'
    // own tests' business.) No Live switch: every capture is live.
    const insidePortal = (node: ts.Node) => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        const tag = ts.isJsxElement(n)
          ? n.openingElement.tagName.getText(file)
          : ts.isJsxSelfClosingElement(n)
            ? n.tagName.getText(file)
            : null
        if (tag === 'CaptureControlsBar') return true
      }
      return false
    }
    for (const tag of ['LiveVoiceIdRow', 'SelectTrigger', 'LiveCapturePills', 'SystemAudioWarning']) {
      expect(elementsNamed(tag).some(insidePortal), tag).toBe(true)
    }
    expect(elementsNamed('Switch'), 'the Live switch is back').toHaveLength(0)
  })

  it('leaves Voice ID off the card while it is in the live agent HUD (this capture recording live)', () => {
    const [portal] = elementsNamed('CaptureControlsBar') as ts.JsxSelfClosingElement[]
    const voiceId = portal.attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(file) === 'voiceId',
    )
    const expr = (voiceId!.initializer as ts.JsxExpression).expression!
    expect(ts.isConditionalExpression(expr), 'voiceId is no longer gated on the HUD').toBe(true)
    const cond = expr as ts.ConditionalExpression
    expect(cond.condition.getText(file)).toBe('voiceIdInHud && isActiveRecording')
    expect(cond.whenTrue.getText(file)).toBe('null')
    expect(cond.whenFalse.getText(file)).toContain('LiveVoiceIdRow')
  })

  it('hands the pills their own place at the row end, apart from the controls', () => {
    const [bar] = elementsNamed('CaptureControlsBar') as ts.JsxSelfClosingElement[]
    const attr = (name: string) =>
      bar.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(file) === name,
      )
    const pillsProp = attr('pills')
    expect(pillsProp).toBeDefined()
    expect(pillsProp!.getText(file)).toContain('LiveCapturePills')
    expect(attr('controls')!.getText(file)).not.toContain('LiveCapturePills')
    expect(attr('controls')!.getText(file)).not.toContain('LiveTranscriptsPill')
    // Overview only: the other sections have a foot of their own.
    expect(attr('className')!.getText(file)).toContain("activeSection !== 'overview'")
  })

  it('leaves Tools to LiveCapturePills, which shows it only while recording', () => {
    // The page no longer places either pill itself, so nothing here can show
    // Tools after the recording. (The rule is LiveCapturePills' own test's.)
    expect(elementsNamed('LiveToolsPill')).toHaveLength(0)
    expect(elementsNamed('LiveTranscriptsPill')).toHaveLength(0)
    expect(elementsNamed('LiveCapturePills')).toHaveLength(1)
  })

  it('makes the agent picker a pill like the rest of the controls row', () => {
    // 36px (h-9) and overhanging the row's py-0.5, rounded, ringed, on the
    // app's own background with the row's type — as Transcripts, Tools and
    // Capture are.
    const trigger = elementsNamed('SelectTrigger').find((node) => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(file) === 'CaptureControlsBar') return true
      }
      return false
    }) as ts.JsxOpeningElement
    const classAttr = trigger.attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(file) === 'className',
    )
    const classes = (classAttr!.initializer as ts.StringLiteral).text.split(/\s+/)
    for (const cls of ['h-9', '-my-0.5', 'rounded-full', 'border', 'border-border', 'bg-background', 'text-[12px]', 'px-3']) {
      expect(classes, cls).toContain(cls)
    }
    expect(classes).not.toContain('h-7')
  })

  it('recognises the properties host (control: a property row sits inside it)', () => {
    // Keep a positive control so changes to the preferences host cannot make
    // the card placement assertion pass vacuously.
    const [row] = elementsNamed('ActivityRow')
    expect(row).toBeDefined()
    expect(propertiesGate(row)).toBeDefined()
  })
})
