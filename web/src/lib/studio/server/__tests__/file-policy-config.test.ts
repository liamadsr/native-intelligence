// The Studio's file route sends its own Content-Security-Policy (files.ts: FILE_CSP), but the app-wide policy in
// next.config.mjs is applied to every path after the route answers and replaces a header of the same name. So the
// config carries the same policy for the file route's path, later in its list (later headers win for the same key).
// This holds the two together.
import { describe, expect, it } from 'vitest'
import { headers } from '../../../../../next.config.mjs'
import { STUDIO_API } from '@/components/studio/studio-env'
import { FILE_CSP } from '../files'

describe("the Studio's stored files and the app-wide headers", () => {
  it('the config gives the file route the sandbox policy, after the app-wide one', async () => {
    const list = (await headers()) as { source: string; headers: { key: string; value: string }[] }[]
    const policyOf = (entry: { headers: { key: string; value: string }[] }) => entry.headers.find((h) => h.key === 'Content-Security-Policy')?.value
    const appWide = list.findIndex((entry) => entry.source === '/(.*)' && policyOf(entry))
    const files = list.findIndex((entry) => entry.source === `${STUDIO_API}/file/:path*`)
    expect(appWide).toBeGreaterThanOrEqual(0)
    expect(files).toBeGreaterThan(appWide)
    expect(policyOf(list[files]!)).toBe(FILE_CSP)
  })
})
