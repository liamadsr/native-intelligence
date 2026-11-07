/**
 * Every work item opens where the rules put it (docs/plans/bots-v4.md "An item
 * opens on its bot's page", Phase 2): through useOpenWorkItem or openItem
 * (open-teammate.ts), on its bot's page, else over the Inbox; never straight
 * onto the Agents page, which is gone (Phase 7b). Pinned by source: no file
 * builds an entry for a detail on it.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** The source files under `dir`, tests and dependencies left out, as paths from src. */
function sources(dir: string, src: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sources(path, src))
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(relative(src, path).split(sep).join('/'))
  }
  return out
}

describe('an item opens on its bot’s page, never on the Agents page', () => {
  const src = join(process.cwd(), 'src')
  const files = sources(src, src)
  const naming = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(join(src, file), 'utf8')))

  it('no file builds a detail entry on the Agents page (buildEntryForDetail(\'agent-work\', …))', () => {
    expect(naming(/buildEntryForDetail\(\s*['"`]agent-work['"`]/)).toEqual([])
  })

  it('the callers Phase 2 moved open items through the one opener', () => {
    const opener = /\buseOpenWorkItem\b|\bopenItem\(/
    for (const file of [
      'app/account/(dashboard)/chat/teammate-report-chip.tsx',
      'components/work/entity-activity-tab.tsx',
      'components/work/work-item-detail-panel.tsx',
      'components/bots/bot-page/use-bot-page-open.ts',
      'components/desktop/native-notification-click-handler.tsx',
    ]) {
      expect(files, file).toContain(file)
      expect(opener.test(readFileSync(join(src, file), 'utf8')), file).toBe(true)
    }
  })

  it('nothing opens a run’s chat in a tab of its own any more (the tab entry carries the item, not a run)', () => {
    expect(naming(/\breplaceRunId\b/)).toEqual([])
    // Nothing names a run's title any more (the tabs are chats: no saved page entries to restore, P5).
    expect(naming(/\brunTitle\b/)).toEqual([])
  })
})
