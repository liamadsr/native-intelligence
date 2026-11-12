/**
 * Made-up material for the ads tests: an invented brand ("Tessel Bloom", a
 * plant shop that does not exist), its palette, two free fonts that ship
 * inside packages already installed (a KaTeX serif and Geist, both under the
 * SIL Open Font License, copied at run time, never committed), a logo mask and
 * photos drawn here in the browser, and a tone and clips made by FFmpeg. No real
 * brand, photo or person anywhere.
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { Browser } from 'playwright-core'

const require = createRequire(import.meta.url)
/** The app's ads contract (values come through require: web/ is CommonJS to tsx). */
export const contract = require('../../web/src/lib/studio/server/ads-contract.ts') as typeof import('../../web/src/lib/studio/server/ads-contract.ts')

const WEB = resolve(import.meta.dirname, '../../web/node_modules')
export const FONT_FILES = {
  serif: join(WEB, 'katex/dist/fonts/KaTeX_Main-Regular.ttf'),
  serifItalic: join(WEB, 'katex/dist/fonts/KaTeX_Main-Italic.ttf'),
  sans: join(WEB, 'next/dist/next-devtools/server/font/geist-latin.woff2'),
}

/** The brand as a brand folder keeps it (brand.json, fonts.json, rules.json, sound.json), to paste. */
export const PASTED = {
  'brand.json': {
    brand: 'Tessel Bloom',
    palette: {
      oat: { hex: '#F2EBE3', use: 'main ground' }, sprout: { hex: '#DDEFE3' }, pine: { hex: '#23402F' }, bark: { hex: '#2E2A28' },
      leaf: { hex: '#7FBF8E' }, stone: { hex: '#6F7A72' }, clay: { hex: '#D9C9B8' }, sun: { hex: '#F4D35E' }, honey: { hex: '#E8B04B' }, white: { hex: '#FFFFFF' },
    },
    roles: { ground: 'oat', groundAlt: 'sprout', deep: 'pine', ink: 'bark', accent: 'leaf', muted: 'stone', line: 'clay', highlight: 'sun', star: 'honey', white: 'white' },
    logo: { treatments: [{ background: 'oat', logo: 'pine' }, { background: 'sprout', logo: 'pine' }, { background: 'pine', logo: 'sprout' }, { background: 'bark', logo: 'oat' }], onPhoto: { colours: ['white'] } },
    voice: 'warm, plain, unhurried',
  },
  'fonts.json': {
    serif: { brand: 'Tessel Display', family: 'Fixture Serif', faces: [{ file: 'Fixture-Serif-Regular.ttf', weight: 400, style: 'normal' }, { file: 'Fixture-Serif-Italic.ttf', weight: 400, style: 'italic' }], weights: { thin: 400, light: 400, regular: 400 } },
    sans: { brand: 'Tessel Sans', family: 'Fixture Sans', faces: [{ file: 'Fixture-Sans.woff2', weight: '100 900', style: 'normal' }], weights: { medium: 500, bold: 700 } },
  },
  'rules.json': {
    service: { minPx: 40, by: 1, minSeconds: 2 }, minPx: 26, safe: { top: 384, bottom: 1498, side: 48 }, maxHold: 2.5,
    loudness: { lufs: -17, tolerance: 1.5, peak: -1 }, banned: [{ pattern: '\\bmiracle\\b', rule: 'VOICE-3', why: 'a promise the shop can\'t keep' }],
  },
  'sound.json': {
    mix: { musicLufs: -18, sfxUnder: 9, musicFadeIn: 0.3, sfxFadeIn: 0.05, fadeOut: 0.6 },
    sounds: {
      'soft-bed': { src: 'sounds/soft-bed.wav', kind: 'music', key: 'A', use: [0, 4], loop: [1, 4], xfade: 0.3 },
      chime: { src: 'sounds/chime.wav', kind: 'sfx', pitched: false, lufs: -26 },
    },
  },
}

/** Static copy rules for the check (none of the real playbook's). */
export const COPY_BANS = [{ pattern: '\\b(cure|miracle)\\b', rule: 'VOICE-3', why: 'a promise the shop can\'t keep' }]

/** Draw a page in the browser and save it: PNG (with transparency when `transparent`) or, via FFmpeg, JPEG. */
export async function draw(browser: Browser, html: string, width: number, height: number, out: string, transparent = false): Promise<string> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;${transparent ? 'background:transparent' : ''}">${html}</body></html>`)
  const png = out.endsWith('.png') ? out : `${out}.png`
  await page.screenshot({ path: png, omitBackground: transparent })
  await page.close()
  if (png !== out) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '2', out])
  return out
}

/** The photos, the person's matte, and the logo masks. People data is for the person in `room.jpg`. */
export async function drawMaterial(browser: Browser, dir: string) {
  await mkdir(dir, { recursive: true })
  const person = (fill: string, skin: string) => `
    <div style="position:absolute;left:830px;top:250px;width:260px;height:300px;border-radius:50% 50% 46% 46%;background:${skin}"></div>
    <div style="position:absolute;left:700px;top:520px;width:520px;height:760px;border-radius:220px 220px 0 0;background:${fill}"></div>`
  const room = await draw(browser, `<div style="position:absolute;inset:0;background:linear-gradient(160deg,#cbb59c 0%,#8d6e55 55%,#4b3a2e 100%)"></div>
    <div style="position:absolute;left:120px;top:120px;width:420px;height:560px;background:linear-gradient(180deg,#fdf6e8,#e9dcc4);box-shadow:0 0 120px 40px rgba(255,240,210,.5)"></div>
    <div style="position:absolute;left:1180px;top:640px;width:260px;height:340px;border-radius:30px 30px 8px 8px;background:radial-gradient(circle at 50% 20%,#6aa37a,#2f5a3d)"></div>
    ${person('#5a6b7c', '#d9a98a')}`, 1600, 1200, join(dir, 'room.jpg'))
  const matte = await draw(browser, `<div style="position:absolute;inset:0;background:#000"></div>${person('#fff', '#fff')}`, 1600, 1200, join(dir, 'room-matte.png'))
  const leaves = await draw(browser, `<div style="position:absolute;inset:0;background:#2d4a36"></div>
    ${Array.from({ length: 70 }, (_, i) => { const x = (i * 263) % 1600, y = (i * 401) % 1600, r = 80 + ((i * 37) % 140), g = 90 + ((i * 53) % 90); return `<div style="position:absolute;left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${r}px;border-radius:50% 0;transform:rotate(${(i * 47) % 180}deg);background:rgb(${40 + (i % 5) * 9},${g + 40},${70 + (i % 7) * 6});opacity:.9"></div>` }).join('')}`, 1600, 1600, join(dir, 'leaves.jpg'))
  const bright = await draw(browser, `<div style="position:absolute;inset:0;background:linear-gradient(180deg,#f7f1e6 0%,#efe4d2 60%,#e2d3bc 100%)"></div>
    <div style="position:absolute;left:980px;top:420px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,#ffffff,#f3e6cf)"></div>
    <div style="position:absolute;left:180px;top:620px;width:240px;height:300px;border-radius:24px 24px 120px 120px;background:#c9b49a"></div>`, 1600, 1000, join(dir, 'bright.jpg'))
  const logoText = (color: string) => `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 150px/1 Georgia,serif;letter-spacing:6px;color:${color}">Tessel&nbsp;Bloom</div>`
  const primary = await draw(browser, logoText('#fff'), 1400, 260, join(dir, 'logo-primary.png'), true)
  const mark = await draw(browser, `<div style="position:absolute;left:30px;top:30px;width:240px;height:240px;border-radius:50% 0 50% 0;background:#fff"></div>`, 300, 300, join(dir, 'logo-mark.png'), true)
  const fonts = join(dir, 'fonts')
  await mkdir(fonts, { recursive: true })
  await copyFile(FONT_FILES.serif, join(fonts, 'Fixture-Serif-Regular.ttf'))
  await copyFile(FONT_FILES.serifItalic, join(fonts, 'Fixture-Serif-Italic.ttf'))
  await copyFile(FONT_FILES.sans, join(fonts, 'Fixture-Sans.woff2'))
  return {
    room, matte, leaves, bright, primary, mark,
    fonts: { serif: [join(fonts, 'Fixture-Serif-Regular.ttf'), join(fonts, 'Fixture-Serif-Italic.ttf')], sans: [join(fonts, 'Fixture-Sans.woff2')] },
    people: { width: 1600, height: 1200, faces: [{ x: 830 / 1600, y: 250 / 1200, w: 260 / 1600, h: 300 / 1200 }], heads: [] },
  }
}

/** Two short background clips, a photo-like still is drawn above; a bed and a chime made by FFmpeg. */
export function makeMotionMedia(dir: string) {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args])
  const water = join(dir, 'water.mp4'), mist = join(dir, 'mist.mp4'), bed = join(dir, 'soft-bed.wav'), chime = join(dir, 'chime.wav')
  // A slow, soft texture: noise blurred and drifting (water-like), and a gradient with moving light (mist-like).
  ff(['-f', 'lavfi', '-i', 'cellauto=s=540x960:rate=24:rule=110:random_fill_ratio=0.5,format=gray,gblur=sigma=18,scale=1080:1920,eq=contrast=1.6:brightness=0.05', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', water])
  ff(['-f', 'lavfi', '-i', 'gradients=s=1080x1920:rate=24:speed=0.02:c0=0x2d4a36:c1=0xcfe3d5:c2=0x7fbf8e:nb_colors=3', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', mist])
  // A major triad bed (A), and an unpitched chime-like click of noise.
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=277.18:sample_rate=48000:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=329.63:sample_rate=48000:duration=6',
    '-filter_complex', '[0][1][2]amix=inputs=3,volume=0.6,tremolo=f=2:d=0.3', '-ac', '2', bed])
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=1.2', '-af', 'afade=t=in:d=0.01,afade=t=out:st=0.05:d=1.1:curve=exp,highpass=f=2000', '-ac', '2', chime])
  return { water, mist, bed, chime }
}

export async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2))
}
