#!/usr/bin/env node
// A stand-in for the higgsfield command-line tool, for tests: it prints recorded, made-up JSON for the subcommands
// the worker uses and spends nothing. Every call is appended to HIGGSFIELD_FAKE_LOG (one JSON line of its arguments).
//
//   HIGGSFIELD_FAKE_SCENARIO   signed-out | plan-refused | price-up | no-result   (default: everything works)
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.HIGGSFIELD_FAKE_LOG) appendFileSync(process.env.HIGGSFIELD_FAKE_LOG, `${JSON.stringify(args)}\n`)
const scenario = process.env.HIGGSFIELD_FAKE_SCENARIO ?? ''
const out = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}
const fail = (...lines) => {
  process.stderr.write(lines.map((l) => `Error: ${l}`).join('\n') + '\n')
  process.exit(1)
}
const [a, b, model] = args

const image = (extra = []) => [
  { name: 'prompt', type: 'string', required: true },
  { name: 'aspect_ratio', type: 'string', default: '1:1', enum: ['1:1', '16:9', '9:16', '4:5'] },
  { name: 'image_references', type: 'array', default: null },
  { name: 'resolution', type: 'string', default: '2k', enum: ['1k', '2k'] },
  ...extra,
]
const video = [
  { name: 'prompt', type: 'string', required: true },
  { name: 'start_image', type: 'string' },
  { name: 'aspect_ratio', type: 'string', default: '16:9', enum: ['16:9', '9:16', '1:1'] },
  { name: 'duration', type: 'string', default: '5', enum: ['5', '10'] },
  { name: 'resolution', type: 'string', default: '1080p', enum: ['720p', '1080p'] },
]
const SCHEMAS = {
  nano_banana_flash: image(),
  nano_banana_2_lite: image(),
  seedream_5_0_flash: [{ name: 'prompt', type: 'string' }], // takes no references
  nano_banana_pro: image(),
  kling3_0_turbo: video,
  seedance_2_0_mini: video,
  seedance_2_5: video,
}
const PRICES = { nano_banana_flash: 3, nano_banana_2_lite: 2, nano_banana_pro: 8, kling3_0_turbo: 25, seedance_2_0_mini: 18, seedance_2_5: 90 }

if (a === '--help') out({ usage: 'fake' })
if (a === 'account' && b === 'status') {
  if (scenario === 'signed-out') fail('not signed in', 'run higgsfield auth login')
  out({ credits: 840, email: 'ava@example.test', subscription_plan_type: 'plus' })
}
if (a === 'model' && b === 'get') {
  if (!SCHEMAS[model]) fail(`model ${model} not found`)
  out({ display_name: model, job_type: model, params: SCHEMAS[model], rules: [], type: 'image' })
}
if (a === 'generate' && b === 'cost') {
  if (!(model in PRICES)) fail(`no price for ${model}`)
  out({ credits: PRICES[model] + (scenario === 'price-up' ? 5 : 0) })
}
if (a === 'generate' && b === 'create') {
  if (scenario === 'plan-refused') fail('request failed', '"Pro" or "Ultimate" plan required')
  out({ id: 'hf-job-0001aaaa', status: 'queued' })
}
if (a === 'generate' && b === 'wait') {
  if (scenario === 'no-result') out({ id: model, status: 'completed' })
  out({ id: model, status: 'completed', result_url: `https://cdn.example.test/${model}/output.png` })
}
fail(`unknown command: ${args.join(' ')}`)
