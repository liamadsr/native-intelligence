import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Where a capture's live controls are (Liam, 11-20: the row of floating pills
 * at the foot of its card "looks ugly"; nothing floats at the bottom now):
 *   - the agent and its context packages are PROPERTIES, rows in the
 *     properties panel (WindowProperties), like Set project and Link event;
 *   - Transcripts and Tools are TABS beside Overview and Agents, Tools only
 *     while the capture records (capture-live-sections.tsx);
 *   - Voice ID heads the Transcripts tab, the system-audio notice above it.
 * Never in the chat composer, which is the main agent's.
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

function insideProperties(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(file) === 'WindowProperties') return true
  }
  return false
}

function attrOf(el: ts.Node, name: string): ts.JsxAttribute | undefined {
  const attributes = ts.isJsxSelfClosingElement(el) || ts.isJsxOpeningElement(el) ? el.attributes : undefined
  return attributes?.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(file) === name,
  )
}

describe('where CaptureDetailPanel puts the live capture controls', () => {
  it('has no bar at the foot of the card: no controls bar, no pills, no composer portal', () => {
    for (const tag of ['CaptureControlsBar', 'LiveCapturePills', 'LiveTranscriptsPill', 'LiveToolsPill', 'LiveAgentComposerPortal', 'FloatingLiveAgentPanel']) {
      expect(elementsNamed(tag), tag).toHaveLength(0)
    }
    expect(source).not.toContain('composer-capture-slots')
    expect(source).not.toContain('capture-controls-bar')
    expect(source).not.toContain('live-capture-pills')
  })

  it('makes the agent a property row, opening the same agent list', () => {
    const triggers = elementsNamed('SelectTrigger').filter((t) => attrOf(t, 'data-capture-agent-row'))
    expect(triggers).toHaveLength(1)
    const [trigger] = triggers
    expect(insideProperties(trigger)).toBe(true)
    expect(propertiesGate(trigger)).toBeDefined()
    expect(attrOf(trigger, 'data-capture-agent-row')).toBeDefined()
    // A row like the panel's others (h-8, px-3, text-sm, hover:bg-muted/50),
    // not the old 36px pill with its ring and shadow.
    const classes = (attrOf(trigger, 'className')!.initializer as ts.StringLiteral).text.split(/\s+/)
    for (const cls of ['h-8', 'px-3', 'text-sm', 'hover:bg-muted/50', 'border-0', 'shadow-none']) {
      expect(classes, cls).toContain(cls)
    }
    for (const cls of ['h-9', 'rounded-full', 'shadow-sm']) {
      expect(classes, cls).not.toContain(cls)
    }
    // The list: Assistant and every agent, or only the live persona while it's locked.
    const select = trigger.parent.parent as ts.JsxElement
    const text = select.getText(file)
    expect(text).toContain('ASSISTANT_SENTINEL')
    expect(text).toContain('agents.map')
    expect(text).toContain('liveLockAgent')
    expect(attrOf(select.openingElement, 'disabled')!.getText(file)).toContain('liveLocked && !!liveLockAgent')
  })

  it('makes Packages a property row opening the context-packages checklist, live mode only', () => {
    const rowAt = source.indexOf('data-capture-packages-row')
    expect(rowAt).toBeGreaterThan(-1)
    const checklistAt = source.indexOf('Context packages for this call')
    expect(checklistAt).toBeGreaterThan(rowAt)
    // Both inside the properties panel.
    const props = elementsNamed('WindowProperties')[0].parent as ts.JsxElement
    expect(rowAt).toBeGreaterThan(props.getStart(file))
    expect(checklistAt).toBeLessThan(props.getEnd())
    // The gate is unchanged: live mode, before or during the call.
    const before = source.slice(Math.max(0, rowAt - 2500), rowAt)
    expect(before).toContain('recording.liveModeEnabled && (isActiveRecording || !capture?.ended_at)')
  })

  it('has Transcripts and Tools as tabs, Tools only while the capture records', () => {
    expect(source).toMatch(/CAPTURE_SECTIONS = \['overview', 'transcripts', 'tools', 'agents', 'live-chat'\] as const/)
    expect(source).toContain("tab === 'tools' ? isActiveRecording")
    expect(source).toContain('sectionShown(pickedSection) ? pickedSection')
    expect(elementsNamed('TranscriptsTabLabel')).toHaveLength(1)
    expect(elementsNamed('ToolsTabLabel')).toHaveLength(1)
    expect(elementsNamed('TranscriptsSection')).toHaveLength(1)
    expect(elementsNamed('ToolsSection')).toHaveLength(1)
    for (const tag of ['TranscriptsSection', 'ToolsSection', 'TranscriptsTabLabel']) {
      expect(insideProperties(elementsNamed(tag)[0]), tag).toBe(false)
    }
  })

  it('heads the Transcripts tab with the system-audio notice and Voice ID, not while Voice ID is in the HUD', () => {
    const [section] = elementsNamed('TranscriptsSection')
    expect(attrOf(section, 'notice')!.getText(file)).toContain('SystemAudioWarning')
    const voiceId = attrOf(section, 'voiceId')!
    const expr = (voiceId.initializer as ts.JsxExpression).expression!
    expect(ts.isConditionalExpression(expr)).toBe(true)
    const cond = expr as ts.ConditionalExpression
    expect(cond.condition.getText(file)).toBe('voiceIdInHud && isActiveRecording')
    expect(cond.whenTrue.getText(file)).toBe('null')
    expect(cond.whenFalse.getText(file)).toContain('LiveVoiceIdRow')
    expect(elementsNamed('LiveVoiceIdRow')).toHaveLength(1)
    expect(elementsNamed('SystemAudioWarning')).toHaveLength(1)
  })

  it('recognises the properties host (control: a property row sits inside it)', () => {
    // Keep a positive control so changes to the preferences host cannot make
    // the placement assertions pass vacuously.
    const [row] = elementsNamed('ActivityRow')
    expect(row).toBeDefined()
    expect(propertiesGate(row)).toBeDefined()
    expect(insideProperties(row)).toBe(true)
  })
})
