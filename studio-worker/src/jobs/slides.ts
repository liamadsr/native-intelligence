/**
 * slides: a deck (PDF, PowerPoint or OpenDocument) becomes one image asset per
 * page. PowerPoint and OpenDocument are made a PDF first by LibreOffice,
 * headless; poppler's pdftoppm draws each page 1920 px wide as a PNG. Each page
 * is stored as an asset like an import. The deck's id is the sha256 of the
 * uploaded file.
 */
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildAsset, inspectFile, publishAsset } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { findBinary, run } from '../media.ts'
import { checkAborted, JobError, stage, type JobHandler } from './context.ts'

export const DECK_EXTENSIONS = ['.pdf', '.pptx', '.ppt', '.odp']
export const RASTER_WIDTH = 1920
export const MAX_PAGES = 500

export const NEEDS_LIBREOFFICE =
  'Converting PowerPoint and OpenDocument decks needs LibreOffice on the studio worker (Debian: apt install libreoffice-impress; macOS: brew install --cask libreoffice), or export the deck as PDF.'
export const NEEDS_POPPLER = 'Rendering slides needs poppler’s pdftoppm on the studio worker (Debian: apt install poppler-utils; macOS: brew install poppler).'

export function soffice(env: NodeJS.ProcessEnv = process.env): string | null {
  // On macOS the app's own binary: Homebrew's wrapper can outlive a removed app.
  return findBinary('soffice', ['/Applications/LibreOffice.app/Contents/MacOS/soffice', `${env.HOME ?? ''}/Applications/LibreOffice.app/Contents/MacOS/soffice`], env) ?? findBinary('libreoffice', [], env)
}

/**
 * The settings a throwaway LibreOffice profile starts with: no macros run, whatever the deck says, and no links
 * followed to places the deck does not come from. A deck is a stranger's file; its conversion should touch nothing
 * but itself (the worker's container should also have no way out but to the app and storage: deploy/studio/README.md).
 */
export const LOCKED_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`

/** Write a fresh profile for one conversion under `dir` (its own, removed with the job's scratch folder). */
export async function lockedProfile(dir: string): Promise<string> {
  await mkdir(join(dir, 'user'), { recursive: true })
  await writeFile(join(dir, 'user', 'registrymodifications.xcu'), LOCKED_PROFILE)
  return pathToFileURL(dir).href
}

/** LibreOffice's arguments to make `source` a PDF in `outdir`, with the profile at `profileUrl`. Pure. */
export function sofficeArgs(profileUrl: string, outdir: string, source: string): string[] {
  return [`-env:UserInstallation=${profileUrl}`, '--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nologo', '--convert-to', 'pdf', '--outdir', outdir, source]
}

/** Page files pdftoppm wrote (page-1.png, page-01.png, …) in page order. Pure. */
export function pageOrder(files: string[]): string[] {
  const n = (f: string) => Number(/(\d+)\.png$/.exec(f)?.[1])
  return files.filter((f) => f.endsWith('.png')).sort((a, b) => n(a) - n(b))
}

export const runSlides: JobHandler<'slides'> = async (ctx) => {
  const { uploadKey, name } = ctx.job.input
  const extension = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase()
  if (!DECK_EXTENSIONS.includes(extension)) throw new JobError('Choose a PDF, PowerPoint (.pptx) or OpenDocument (.odp) deck.')
  const source = join(ctx.scratch, `source${extension}`)
  const read = await ctx.client.readBlob(ctx.job.id, uploadKey, source, { signal: ctx.signal })
  if (read.bytes < 5 || read.bytes > 500 * 1024 ** 2) throw new JobError('Slide decks must be nonempty and at most 500 MB')
  const deckId = read.sha256
  ctx.progress(0.1)

  let pdf = source
  if (extension !== '.pdf') {
    const office = soffice()
    if (!office) throw new JobError(NEEDS_LIBREOFFICE)
    ctx.log('Converting the deck to PDF with LibreOffice')
    // A fresh, locked-down profile per job (no macros, no untrusted links), gone with the scratch folder.
    const profile = await lockedProfile(join(ctx.scratch, 'lo-profile'))
    await run(office, sofficeArgs(profile, ctx.scratch, source), {
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
      signal: ctx.signal,
      // LibreOffice writes to its home as well as its profile: the scratch folder, as the root is read-only in the container.
      env: { ...process.env, HOME: ctx.scratch },
    })
    pdf = join(ctx.scratch, 'source.pdf')
    if (!existsSync(pdf)) throw new JobError('LibreOffice did not produce a PDF for this presentation')
  }
  const handle = await open(pdf, 'r')
  const header = Buffer.alloc(5)
  try {
    await handle.read(header, 0, 5, 0)
  } finally {
    await handle.close()
  }
  if (header.toString('latin1') !== '%PDF-') throw new JobError('That file is not a readable PDF')
  ctx.progress(0.3)
  checkAborted(ctx.signal)

  const pdftoppm = findBinary('pdftoppm')
  if (!pdftoppm) throw new JobError(NEEDS_POPPLER)
  const pagesDir = join(ctx.scratch, 'pages')
  await mkdir(pagesDir, { recursive: true })
  try {
    await run(pdftoppm, ['-png', '-scale-to-x', String(RASTER_WIDTH), '-scale-to-y', '-1', pdf, join(pagesDir, 'page')], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal })
  } catch (err) {
    checkAborted(ctx.signal)
    throw new JobError(`Could not render the PDF pages: ${(err as Error).message}`.slice(0, 400))
  }
  const pages = pageOrder(await readdir(pagesDir))
  if (pages.length === 0) throw new JobError('The PDF has no pages')
  if (pages.length > MAX_PAGES) throw new JobError(`Decks are limited to ${MAX_PAGES} slides`)
  ctx.log(`${pages.length} page(s) drawn`)

  const title = name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Slides'
  const done = stage(ctx, 0.4, 1)
  const assets = []
  for (const [index, file] of pages.entries()) {
    checkAborted(ctx.signal)
    const path = join(pagesDir, file)
    const pageName = `${title} — slide ${index + 1}.png`
    const { measured } = await inspectFile(path, pageName, ctx.signal)
    const asset = buildAsset(measured, { sha256: await fileSha256(path), bytes: (await stat(path)).size }, { name: pageName, provenance: { slideDeck: deckId, page: index } })
    await publishAsset(ctx, asset, path)
    assets.push(asset)
    done((index + 1) / pages.length)
  }
  const first = assets[0]!
  return { deck: { id: deckId, name: title, width: first.width ?? RASTER_WIDTH, height: first.height ?? 1080 }, pages: assets }
}
