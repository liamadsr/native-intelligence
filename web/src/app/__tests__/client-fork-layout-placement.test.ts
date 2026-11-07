/**
 * The only-child rule from client-fork-hydration.test.tsx, pinned in the
 * layouts on the shell's path: each client component a server layout wraps
 * the app in sits ALONE inside a HOST element (see that file for why).
 *
 * A source test, so it runs in the plain node environment: under a jsdom
 * environment with NODE_ENV=production — how Vercel runs `vitest run` before
 * `next build` — Vite hands `node:fs` / `node:path` to the file as empty
 * browser stubs, `join` is undefined, and every production build fails.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** Children that render something: not whitespace, not a `{/* comment *\/}`. */
const rendersSomething = (child: ts.JsxChild) =>
  !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) &&
  !(ts.isJsxExpression(child) && !child.expression)

/**
 * Where the `<tag>` element sits: its parent's tag (`'<>'` for a fragment,
 * `null` when it is the returned root) and how many rendering children that
 * parent has.
 */
function placement(file: string, tag: string): { parent: string | null; siblings: number } | null {
  const source = readFileSync(join(process.cwd(), file), 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: { parent: string | null; siblings: number } | null = null
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === tag) {
      const parent = node.parent
      found = ts.isJsxElement(parent)
        ? { parent: parent.openingElement.tagName.getText(sf), siblings: parent.children.filter(rendersSomething).length }
        : ts.isJsxFragment(parent)
          ? { parent: '<>', siblings: parent.children.filter(rendersSomething).length }
          : { parent: null, siblings: 1 }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

// Each wrapping client component sits ALONE inside a HOST element: alone, so
// it is never a forked child; inside a host element, because a layout's root
// is always forked (Next.js renders it beside the segment's asset links) and a
// host element — never a lazy chunk — cannot be replayed.
describe('the layouts put each wrapping client component alone inside a host element', () => {
  it('app/layout.tsx: PostHogProvider wraps the whole app', () => {
    expect(placement('src/app/layout.tsx', 'PostHogProvider')).toEqual({ parent: 'body', siblings: 1 })
  })

  it('account/layout.tsx: AccountProviders wraps every account page', () => {
    expect(placement('src/app/account/layout.tsx', 'AccountProviders')).toEqual({ parent: 'div', siblings: 1 })
  })

  it('account/(dashboard)/layout.tsx: DashboardErrorBoundary wraps the whole shell', () => {
    expect(placement('src/app/account/(dashboard)/layout.tsx', 'DashboardErrorBoundary')).toEqual({
      parent: 'div',
      siblings: 1,
    })
  })
})
