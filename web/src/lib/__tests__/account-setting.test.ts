// @vitest-environment jsdom
/**
 * A setting kept on the account with a copy on this device (../account-setting):
 * the copy read checked; a save shown at once, sent to the account, and taken
 * back when the account refuses it (unless something newer replaced it); the
 * account's value adopted from a profile read (null: the default, the copy
 * removed), unless a save was out or ended after the read began; a setting
 * first used after the profile landed still taking it; saves sent one at a
 * time; another window's copy followed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAccountSettings, beginAccountSettingsRead, createAccountSetting, type AccountSetting } from '../account-setting'

const parse = (raw: unknown) => (typeof raw === 'string' && /^[a-z]+$/.test(raw) ? raw : null)

let n = 0
let made: AccountSetting<string>[] = []
/** A fresh setting: its own field and storage key, so earlier tests' settings never answer for it. */
function makeSetting() {
  n += 1
  const field = `colour_${n}`
  const storageKey = `test:colour:${n}`
  const setting = createAccountSetting<string>({ field, storageKey, parse, same: (a, b) => a === b })
  made.push(setting)
  return { setting, field, storageKey }
}

type Answer = { ok: boolean } | Error
let answers: Answer[] = []
let gates: (() => void)[] = []
let gated = false
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  if (gated) await new Promise<void>((resolve) => gates.push(resolve))
  const answer = answers.shift() ?? { ok: true }
  if (answer instanceof Error) throw answer
  return new Response('{}', { status: answer.ok ? 200 : 500 })
})
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)))
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  window.localStorage.clear()
  answers = []
  gates = []
  gated = false
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const setting of made) setting.resetForTests()
  made = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the copy on this device', () => {
  it('is read checked: a valid copy, else nothing (the default)', () => {
    const a = makeSetting()
    window.localStorage.setItem(a.storageKey, JSON.stringify('teal'))
    expect(a.setting.get()).toBe('teal')
    const b = makeSetting()
    window.localStorage.setItem(b.storageKey, JSON.stringify('Not One'))
    expect(b.setting.get()).toBeNull()
    const c = makeSetting()
    window.localStorage.setItem(c.storageKey, '{junk')
    expect(c.setting.get()).toBeNull()
  })

  it('follows another window even for a reader that never subscribes (the HUD’s wake word)', () => {
    const { setting, storageKey } = makeSetting()
    expect(setting.get()).toBeNull()
    window.localStorage.setItem(storageKey, JSON.stringify('plum'))
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey }))
    expect(setting.get()).toBe('plum')
  })

  it('follows another window’s copy', () => {
    const { setting, storageKey } = makeSetting()
    const heard = vi.fn()
    setting.subscribe(heard)
    window.localStorage.setItem(storageKey, JSON.stringify('plum'))
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey }))
    expect(setting.get()).toBe('plum')
    expect(heard).toHaveBeenCalledTimes(1)
    window.localStorage.removeItem(storageKey)
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey }))
    expect(setting.get()).toBeNull()
  })
})

describe('a save', () => {
  it('shows at once, goes to the account, and keeps the copy', async () => {
    const { setting, field, storageKey } = makeSetting()
    const heard = vi.fn()
    setting.subscribe(heard)
    const saving = setting.save('teal')
    expect(setting.get()).toBe('teal')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(await saving).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/account/profile', expect.objectContaining({ method: 'PATCH' }))
    expect(bodies()).toEqual([{ [field]: 'teal' }])
    expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify('teal'))
  })

  it('refuses a value that isn’t one, and sends nothing', async () => {
    const { setting } = makeSetting()
    expect(await setting.save('Not One')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setting.get()).toBeNull()
  })

  it('the account refusing it, or the network failing, puts the old value back', async () => {
    const { setting, storageKey } = makeSetting()
    answers = [{ ok: false }]
    expect(await setting.save('teal')).toBe(false)
    expect(setting.get()).toBeNull()
    expect(window.localStorage.getItem(storageKey)).toBeNull()

    expect(await setting.save('plum')).toBe(true)
    answers = [new TypeError('offline')]
    expect(await setting.save('teal')).toBe(false)
    expect(setting.get()).toBe('plum')
    expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify('plum'))
  })

  it('a failed save never undoes a newer one', async () => {
    const { setting } = makeSetting()
    gated = true
    answers = [{ ok: false }, { ok: true }]
    const first = setting.save('teal')
    const second = setting.save('plum')
    await tick()
    gates.shift()!()
    expect(await first).toBe(false)
    expect(setting.get()).toBe('plum')
    await tick()
    gates.shift()!()
    expect(await second).toBe(true)
    expect(setting.get()).toBe('plum')
  })

  it('saves go to the account one at a time', async () => {
    const a = makeSetting()
    const b = makeSetting()
    gated = true
    const first = a.setting.save('teal')
    const second = b.setting.save('plum')
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    gates.shift()!()
    await first
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    gates.shift()!()
    await second
    expect(bodies()).toEqual([{ [a.field]: 'teal' }, { [b.field]: 'plum' }])
  })
})

describe('the account’s value, from a profile read', () => {
  it('is adopted and copied; null (never saved) is the default, the copy removed; absent says nothing', () => {
    const { setting, field, storageKey } = makeSetting()
    applyAccountSettings({ [field]: 'teal' }, beginAccountSettingsRead())
    expect(setting.get()).toBe('teal')
    expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify('teal'))

    applyAccountSettings({ id: 'user-1' }, beginAccountSettingsRead())
    expect(setting.get()).toBe('teal')

    applyAccountSettings({ [field]: null }, beginAccountSettingsRead())
    expect(setting.get()).toBeNull()
    expect(window.localStorage.getItem(storageKey)).toBeNull()

    applyAccountSettings({ [field]: 'teal' }, beginAccountSettingsRead())
    applyAccountSettings({ [field]: 'Junk Value' }, beginAccountSettingsRead())
    expect(setting.get()).toBeNull()
  })

  it('replaces another account’s copy: signing into another account brings that account’s', () => {
    const { setting, field, storageKey } = makeSetting()
    window.localStorage.setItem(storageKey, JSON.stringify('teal'))
    expect(setting.get()).toBe('teal')
    applyAccountSettings({ id: 'user-2', [field]: null }, beginAccountSettingsRead())
    expect(setting.get()).toBeNull()
    applyAccountSettings({ id: 'user-3', [field]: 'plum' }, beginAccountSettingsRead())
    expect(setting.get()).toBe('plum')
  })

  it('is dropped when a save began after the read did, or is still out', async () => {
    const { setting, field } = makeSetting()
    const before = beginAccountSettingsRead()
    await setting.save('teal')
    applyAccountSettings({ [field]: 'plum' }, before)
    expect(setting.get()).toBe('teal')

    gated = true
    const saving = setting.save('mint')
    const during = beginAccountSettingsRead()
    applyAccountSettings({ [field]: 'plum' }, during)
    expect(setting.get()).toBe('mint')
    await tick()
    gates.shift()!()
    await saving
    // Once it has settled, reads count again.
    applyAccountSettings({ [field]: 'plum' }, beginAccountSettingsRead())
    expect(setting.get()).toBe('plum')
  })

  it('is dropped when it began while a save was out, even landing after it', async () => {
    const { setting, field } = makeSetting()
    gated = true
    const saving = setting.save('mint')
    const during = beginAccountSettingsRead()
    await tick()
    gates.shift()!()
    await saving
    applyAccountSettings({ [field]: 'plum' }, during)
    expect(setting.get()).toBe('mint')
  })

  it('reaches a setting first used after the profile landed', () => {
    n += 1
    const field = `colour_${n}`
    applyAccountSettings({ [field]: 'teal' }, beginAccountSettingsRead())
    const late = createAccountSetting<string>({ field, storageKey: `test:colour:${n}`, parse, same: (a, b) => a === b })
    made.push(late)
    expect(late.get()).toBe('teal')
  })
})
