import type { BrowserObservation } from '@/lib/browser-agent/task-contract'
import type { BrowserEvidenceLedger } from '@/lib/browser-agent/browser-evidence'

type Control = BrowserObservation['elements'][number]
type State = Record<string, unknown> & {
  instruction: string
  controls: Record<string, string>
  textExcerpts: string[]
  textTruncated: boolean
  evidenceLedger?: BrowserEvidenceLedger
  evidence?: BrowserObservation['evidence']
}
type SharedContext = { text: string } | { excerpt: string; truncated: true }

const COMPACT_INSTRUCTIONS = ' Control contextRef and dialogRef resolve against controlContexts and controlDialogs in this same state. Context excerpts may omit useful distinctions; choose escalate if omitted context is needed to choose safely. Omission never proves absence.'

/** Preserve the readable small-page format; share repetitive descriptions only
 * when it would exceed the remaining state + largest-question UTF-8 budget.
 * Compaction never removes an action target or shortens its name, current
 * value, task bindings, or completion predicates. */
export function compactBrowserDecisionState(base: State, elements: readonly Control[], maxBytes = 28000): string {
  const encoder = new TextEncoder()
  const bytes = (value: string) => encoder.encode(value).length
  // The readable serializer uses bounded control descriptions. Make their
  // existing excerpts explicit, including on otherwise small observations.
  const valueExcerpts = elements.filter(element => element.value.length > 200).map(element => element.ref)
  const contextExcerpts = elements.filter(element => element.context.trim() !== element.name.trim() &&
    element.context.trim().length > 100).map(element => element.ref)
  const readable = JSON.stringify({ ...base,
    ...(valueExcerpts.length || contextExcerpts.length ? { controlDescriptionExcerpts: {
      ...(valueExcerpts.length ? { values: valueExcerpts } : {}),
      ...(contextExcerpts.length ? { contexts: contextExcerpts } : {}),
      note: 'Listed control descriptions are excerpts; omitted content is not evidence of absence.',
    } } : {}),
  })
  if (bytes(readable) <= maxBytes) return readable

  // A ledger is supporting read evidence. It may not crowd out any currently
  // executable control or exact current-state predicate. Copy before pruning;
  // queue state and the eventual parent result retain the full bounded ledger.
  let decisionBase = base

  const compact = (contextLimit: number, textLimit: number) => {
    const controlContexts: Record<string, SharedContext> = {}
    const controlDialogs: Record<string, string> = {}
    const contextIds = new Map<string, string>(), dialogIds = new Map<string, string>()
    const controls = Object.fromEntries(elements.map(element => {
      const context = element.context.trim()
      let contextRef: string | undefined, dialogRef: string | undefined
      if (context && context !== element.name.trim()) {
        contextRef = contextIds.get(context)
        if (!contextRef) {
          contextRef = `c${contextIds.size}`
          contextIds.set(context, contextRef)
          controlContexts[contextRef] = context.length > contextLimit
            ? { excerpt: context.slice(0, contextLimit), truncated: true } : { text: context }
        }
      }
      if (element.dialog) {
        dialogRef = dialogIds.get(element.dialog)
        if (!dialogRef) {
          dialogRef = `d${dialogIds.size}`
          dialogIds.set(element.dialog, dialogRef)
          controlDialogs[dialogRef] = element.dialog
        }
      }
      return [element.ref, {
        role: element.role, name: element.name,
        ...(element.canType ? { editable: true } : {}),
        ...(element.value ? { value: element.value } : {}),
        ...(element.checked !== undefined ? { checked: element.checked } : {}),
        ...(element.selected !== undefined ? { selected: element.selected } : {}),
        ...(element.expanded !== undefined ? { expanded: element.expanded } : {}),
        ...(element.input ? { input: element.input } : {}),
        ...(element.options ? { nativeDropdown: true, ...(element.optionsTruncated ? { optionsTruncated: true } : {}) } : {}),
        ...(element.focused ? { focused: true } : {}), ...(element.frame ? { frame: element.frame } : {}),
        ...(contextRef ? { contextRef } : {}), ...(dialogRef ? { dialogRef } : {}),
      }]
    }))
    let remaining = textLimit
    const textExcerpts = decisionBase.textExcerpts.flatMap(text => {
      if (remaining <= 0) return []
      const excerpt = text.slice(0, remaining)
      remaining -= excerpt.length
      return [excerpt]
    })
    const textShortened = textExcerpts.length !== decisionBase.textExcerpts.length || textExcerpts.some((text, i) => text !== decisionBase.textExcerpts[i])
    return { ...decisionBase, instruction: decisionBase.instruction + COMPACT_INSTRUCTIONS, controls,
      ...(contextIds.size ? { controlContexts } : {}), ...(dialogIds.size ? { controlDialogs } : {}),
      textExcerpts, textTruncated: decisionBase.textTruncated || textShortened,
    }
  }

  // Try lossless control sharing with all historical findings first. If it
  // still does not fit, omit old pages explicitly before clipping current
  // supporting text. Keep the first source page longest for collection order.
  if (base.evidenceLedger?.pages.length) {
    const lossless = JSON.stringify(compact(Infinity, Infinity))
    if (bytes(lossless) <= maxBytes) return lossless
    const pages = [...base.evidenceLedger.pages]
    while (pages.length) {
      pages.splice(pages.length > 2 ? 1 : pages.length - 1, 1)
      decisionBase = { ...base, evidenceLedger: { ...base.evidenceLedger, pages: [...pages], truncated: true } }
      const candidate = JSON.stringify(compact(Infinity, Infinity))
      if (bytes(candidate) <= maxBytes) return candidate
    }
  }

  // Offscreen reading pairs are optional supporting evidence. Preserve the
  // queue's full inventory, but prune this decision copy before clipping
  // current text or control context. Never touch visible heading/dialog proof.
  if (decisionBase.evidence?.documentLinks?.length) {
    const evidence = decisionBase.evidence
    const links = [...(evidence.documentLinks ?? [])]
    while (links.length) {
      links.pop()
      decisionBase = { ...decisionBase, evidence: { ...evidence,
        documentLinks: [...links], documentLinksTruncated: true } }
      const candidate = JSON.stringify(compact(Infinity, Infinity))
      if (bytes(candidate) <= maxBytes) return candidate
    }
  }

  if (decisionBase.evidence?.documentRecords?.length) {
    const evidence = decisionBase.evidence
    const records = [...(evidence.documentRecords ?? [])]
    while (records.length) {
      records.pop()
      decisionBase = { ...decisionBase, evidence: { ...evidence,
        documentRecords: [...records], documentRecordsTruncated: true } }
      const candidate = JSON.stringify(compact(Infinity, Infinity))
      if (bytes(candidate) <= maxBytes) return candidate
    }
  }

  // Try lossless shared descriptions first. Only supporting prose/context may
  // become explicitly marked excerpts under further pressure. Keep every ref,
  // exact value and evidence predicate even if they alone cannot fit.
  const stages = [[Infinity, Infinity], [100, 1800], [60, 900], [0, 0]] as const
  let smallest: ReturnType<typeof compact> | undefined
  let smallestBytes = Infinity
  for (const [contextLimit, textLimit] of stages) {
    const candidate = compact(contextLimit, textLimit)
    const serialized = JSON.stringify(candidate)
    const size = bytes(serialized)
    if (size <= maxBytes) return serialized
    if (!smallest || size < smallestBytes) {
      smallest = candidate; smallestBytes = size
    }
  }
  // The caller/runner must still reject this oversized state. Do not turn a
  // partial candidate inventory or sliced binding into apparently complete input.
  return JSON.stringify({ ...smallest, stateBudgetExceeded: true })
}
