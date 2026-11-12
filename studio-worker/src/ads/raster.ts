/**
 * The raster work the ads do outside the browser: reading pixels of a region
 * (the brand check), comparing two renders (the depth layer), shrinking photos,
 * a logo mask's data URL, gradient maps, a contact strip. ImageMagick (`magick`)
 * does each when it is installed; FFmpeg does the
 * same otherwise, so an image without ImageMagick still renders every ad.
 *
 * STUDIO_ADS_NO_MAGICK=1 forces the FFmpeg path (the tests use it).
 */
import { readFile } from 'node:fs/promises'
import { findBinary, run, runBuffer } from '../media.ts'

/** The magick binary, or null (absent, or turned off with STUDIO_ADS_NO_MAGICK). */
export function magick(): string | null {
  if (process.env.STUDIO_ADS_NO_MAGICK === '1') return null
  return findBinary('magick')
}

/** A PNG's size from its header. */
export async function pngSizeOf(path: string): Promise<{ width: number; height: number }> {
  const b = await readFile(path)
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') throw new Error(`Not a PNG: ${path}`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** Any image's size (ffprobe reads every format the ads take). */
export async function imageSize(path: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path], { signal })
  const [w, h] = stdout.trim().split('\n')[0]!.split('x').map(Number)
  if (!(w! > 0 && h! > 0)) throw new Error(`Could not read the size of ${path}`)
  return { width: w!, height: h! }
}

export type Rect = { x: number; y: number; w: number; h: number }

const toPixels = (buf: Buffer): number[][] => {
  const px: number[][] = []
  for (let i = 0; i + 2 < buf.length; i += 3) px.push([buf[i]!, buf[i + 1]!, buf[i + 2]!])
  return px
}

/** Pixels of a region of a PNG, downsampled to n×n (RGB). The region is kept inside the image. */
export async function region(png: string, r: Rect, n = 24): Promise<number[][]> {
  const { width, height } = await pngSizeOf(png)
  const x = Math.min(width - 1, Math.max(0, Math.round(r.x))), y = Math.min(height - 1, Math.max(0, Math.round(r.y)))
  const w = Math.max(1, Math.min(width - x, Math.round(r.w + Math.min(0, r.x)))), h = Math.max(1, Math.min(height - y, Math.round(r.h + Math.min(0, r.y))))
  const m = magick()
  const buf = m
    ? await runBuffer(m, [png, '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-resize', `${n}x${n}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 20 })
    : await runBuffer('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=${w}:${h}:${x}:${y},scale=${n}:${n}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 })
  return toPixels(buf)
}

/** A whole image downsampled to n×n (RGB): the photo checks. */
export async function thumbnailPixels(path: string, n = 48): Promise<number[][]> {
  const m = magick()
  const buf = m
    ? await runBuffer(m, [path, '-resize', `${n}x${n}!`, '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 20 })
    : await runBuffer('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${n}:${n}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 })
  return toPixels(buf)
}

/** How many pixels of two same-size images differ by more than `fuzz` (0–1 of the colour range). */
export async function differingPixels(a: string, b: string, fuzz = 0.12): Promise<number> {
  const m = magick()
  if (m) {
    try {
      await run(m, ['compare', '-metric', 'AE', '-fuzz', `${Math.round(fuzz * 100)}%`, a, b, 'null:'])
      return 0
    } catch (e) {
      // compare exits 1 when the images differ and prints the count on stderr: the tool error carries it.
      const m2 = /failed: ([\d.e+]+)/.exec((e as Error).message)
      return m2 ? parseFloat(m2[1]!) || 0 : 0
    }
  }
  const raw = (f: string) => runBuffer('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 << 20 })
  const [pa, pb] = await Promise.all([raw(a), raw(b)])
  let n = 0
  const limit = fuzz * 255
  for (let i = 0; i + 2 < Math.min(pa.length, pb.length); i += 3) {
    const d = Math.sqrt(((pa[i]! - pb[i]!) ** 2 + (pa[i + 1]! - pb[i + 1]!) ** 2 + (pa[i + 2]! - pb[i + 2]!) ** 2) / 3)
    if (d > limit) n++
  }
  return n
}

/** A photo shrunk to at most `max` px on its long side, as JPEG (big originals make Chromium slow). */
export async function shrinkPhoto(src: string, dst: string, max = 2400, signal?: AbortSignal): Promise<void> {
  const m = magick()
  if (m) await run(m, [`${src}[0]`, '-auto-orient', '-resize', `${max}x${max}>`, '-quality', '92', dst], { signal, timeout: 120_000 })
  else await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`, '-q:v', '2', dst], { signal, timeout: 120_000 })
}

/** A PNG mask as a data URL (CSS masks are fetched in CORS mode, which a file:// page can't satisfy), at most `width` wide. */
export async function maskDataUrl(png: string, width: number): Promise<string> {
  const m = magick()
  const bytes = m ? await runBuffer(m, [png, '-resize', `${width}x>`, 'png:-'], { maxBuffer: 32 << 20 }) : await readFile(png)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

/** A JPEG of images side by side (all the same height): the motion ad's strip. */
export async function appendSideBySide(files: string[], out: string, signal?: AbortSignal): Promise<void> {
  const m = magick()
  if (m) await run(m, [...files, '+append', out], { signal })
  else await run('ffmpeg', ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${files.length}`, '-frames:v', '1', '-q:v', '3', out], { signal })
}

/** A colour (#RRGGBB) as [r, g, b]. */
export const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A gradient map's files: the 256×1 gradient through three stops and a HALD CLUT (level 8) that maps every colour
 * by its grey value onto it, for FFmpeg's haldclut.
 */
export async function gradientFiles(stops: [string, string, string], grad: string, hald: string, signal?: AbortSignal): Promise<void> {
  const [a, b, c] = stops
  const m = magick()
  if (m) {
    await run(m, ['(', '-size', '1x128', `gradient:${a}-${b}`, ')', '(', '-size', '1x128', `gradient:${b}-${c}`, ')', '-append', '-rotate', '-90', grad], { signal })
    await run(m, ['hald:8', '-colorspace', 'gray', grad, '-clut', hald], { signal })
    return
  }
  // The same in FFmpeg: an identity HALD, its grey (Rec. 709 luma), then each channel through the stops.
  const [ra, ga, ba] = hexRgb(a), [rb, gb, bb] = hexRgb(b), [rc, gc, bc] = hexRgb(c)
  const lerp = (x: number, y: number, z: number) => `if(lt(val,128),${x}+(${y}-${x})*val/127,${y}+(${z}-${y})*(val-128)/127)`
  const map = `lutrgb=r='${lerp(ra, rb, rc)}':g='${lerp(ga, gb, gc)}':b='${lerp(ba, bb, bc)}'`
  const gray = 'colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126:gg=0.7152:gb=0.0722:br=0.2126:bg=0.7152:bb=0.0722'
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'haldclutsrc=level=8', '-frames:v', '1', '-vf', `format=rgb24,${gray},${map}`, hald], { signal })
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=256x1,format=gray,geq=lum=X', '-frames:v', '1', '-vf', `format=rgb24,${map}`, grad], { signal })
}

/**
 * A photo prepared for a motion background: scaled to cover `sw`×`sh`, cropped to the `cw`×`ch` window at
 * (ox, oy), the gradient map blended over it at `strength`, saturation scaled, and an S-curve of `contrast`
 * (ImageMagick's sigmoidal contrast about 50 %).
 */
export async function prepareStill(
  src: string,
  out: string,
  o: { sw: number; sh: number; cw: number; ch: number; ox: number; oy: number; grad?: string; hald?: string; strength: number; saturation: number; contrast: number },
  signal?: AbortSignal,
): Promise<void> {
  const m = magick()
  if (m) {
    await run(m, [src, '-resize', `${o.sw}x${o.sh}!`, '-crop', `${o.cw}x${o.ch}+${o.ox}+${o.oy}`, '+repage',
      ...(o.grad ? ['(', '+clone', '-colorspace', 'gray', o.grad, '-clut', ')', '-compose', 'blend', '-define', `compose:args=${Math.round(o.strength * 100)}`, '-composite'] : []),
      '-modulate', `100,${Math.round(o.saturation * 100)}`, '-sigmoidal-contrast', `${o.contrast},50%`, out], { signal, timeout: 300_000 })
    return
  }
  const c = o.contrast
  const sig = c > 0
    ? `lutrgb=r='${sigmoid(c)}':g='${sigmoid(c)}':b='${sigmoid(c)}'`
    : 'null'
  const graded = o.hald
    ? `split[o][pre];[pre][1:v]haldclut[gr];[gr][o]blend=all_mode=normal:all_opacity=${o.strength}`
    : 'null'
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, ...(o.hald ? ['-i', o.hald] : []), '-frames:v', '1', '-filter_complex',
    `[0:v]scale=${o.sw}:${o.sh}:flags=lanczos,crop=${o.cw}:${o.ch}:${o.ox}:${o.oy},format=rgb24,${graded},eq=saturation=${o.saturation},${sig}`, out], { signal, timeout: 300_000 })
}

/** ImageMagick's sigmoidal contrast about the middle, as an FFmpeg lut expression on 0–255. */
function sigmoid(c: number): string {
  const lo = 1 / (1 + Math.exp(c * 0.5)), hi = 1 / (1 + Math.exp(-c * 0.5))
  return `255*((1/(1+exp(${c}*(0.5-val/255))))-${lo.toFixed(6)})/${(hi - lo).toFixed(6)}`
}

/** A logo mask (white with alpha, or any colour with alpha) recoloured to `hex`, alpha kept. */
export async function colorizeLogo(mask: string, hex: string, out: string, signal?: AbortSignal): Promise<void> {
  const m = magick()
  if (m) {
    await run(m, [mask, '-alpha', 'on', '-fill', hex, '-colorize', '100', out], { signal })
    return
  }
  const [r, g, b] = hexRgb(hex)
  await run('ffmpeg', ['-v', 'error', '-y', '-i', mask, '-frames:v', '1', '-vf', `format=rgba,lutrgb=r=${r}:g=${g}:b=${b}`, out], { signal })
}
