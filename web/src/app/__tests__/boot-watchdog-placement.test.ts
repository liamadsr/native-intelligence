/**
 * The boot watchdog's two halves are both in the root layout: the inline
 * script in <head>, and BootMark inside the app. Without BootMark every page
 * in production would be reloaded as one that never started; without the
 * script a page whose chunks failed would stay blank again.
 *
 * A source test in the plain node environment, like
 * client-fork-layout-placement.test.ts (see its note on node:fs under jsdom).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** The tag names of the JSX elements around every `<tag />` in the file, innermost first. */
function ancestors(file: string, tag: string): string[][] {
  const source = readFileSync(join(process.cwd(), file), 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[][] = []
  const visit = (node: ts.Node) => {
    const name = ts.isJsxSelfClosingElement(node)
      ? node.tagName.getText(sf)
      : ts.isJsxElement(node)
        ? node.openingElement.tagName.getText(sf)
        : null
    if (name === tag) {
      const chain: string[] = []
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isJsxElement(p)) chain.push(p.openingElement.tagName.getText(sf))
      }
      found.push(chain)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('the boot watchdog in the root layout', () => {
  it('runs its script in <head>, before anything else can fail', () => {
    expect(ancestors('src/app/layout.tsx', 'BootWatchdogScript')).toEqual([['head', 'html']])
  })

  it('marks the page started from inside the app', () => {
    expect(ancestors('src/app/layout.tsx', 'BootMark')).toEqual([['PostHogProvider', 'body', 'html']])
  })
})
