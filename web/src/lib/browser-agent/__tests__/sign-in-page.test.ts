/**
 * The sign-in page rule (src/lib/browser-agent/sign-in-page.ts): what stops a
 * browser task for the person to sign in, and what must never be taken for it.
 */
import { describe, expect, it } from 'vitest'
import { looksLikeSignInUrl, signInPage } from '../sign-in-page'

type El = Parameters<typeof signInPage>[0]['elements'] extends readonly (infer E)[] | undefined ? E : never
const field = (name: string, over: Partial<El> = {}): El =>
  ({ role: 'textbox', name, context: '', canType: true, disabled: false, forbidden: false, input: { type: 'text', autocomplete: '' }, ...over })
/** A password field as the page runtime reports it: never typable, forbidden, no input hints, its kind named. */
const password = (name = 'Password', over: Partial<El> = {}): El =>
  ({ role: 'textbox', name, context: '', canType: false, disabled: false, forbidden: true, secretKind: 'password', ...over })
const button = (name: string): El => ({ role: 'button', name, context: '', canType: false, disabled: false, forbidden: false })
const LONG = 'Orders and news. '.repeat(200)

describe('looksLikeSignInUrl', () => {
  it('knows sign-in hosts and whole path segments, never a word that merely contains one', () => {
    for (const url of ['https://example.com/login', 'https://example.com/users/sign_in?next=%2F', 'https://accounts.example.com/', 'https://login.example.com/x', 'https://example.com/oauth2/authorize'])
      expect(looksLikeSignInUrl(new URL(url)), url).toBe(true)
    for (const url of ['https://example.com/signals', 'https://example.com/authors/kim', 'https://example.com/blog/login-tips', 'https://example.com/signup'])
      expect(looksLikeSignInUrl(new URL(url)), url).toBe(false)
  })
})

describe('signInPage', () => {
  it('one password field on a sign-in address, or on a page that says little else, is a sign-in page named by its site', () => {
    expect(signInPage({ url: 'https://www.example.com/login', text: LONG, elements: [field('Email'), password(), button('Sign in')] })).toBe('example.com')
    expect(signInPage({ url: 'https://app.example.com/orders', text: 'Please sign in to continue', elements: [field('Email'), password(), button('Log in')] })).toBe('app.example.com')
    // The field's kind says it, whatever the site calls the field (another language, no label).
    expect(signInPage({ url: 'https://example.com/login', text: '', elements: [password('Mot de passe')] })).toBe('example.com')
    expect(signInPage({ url: 'https://example.com/login', text: '', elements: [password('')] })).toBe('example.com')
    // As real pages are: a "Forgot password?" link is forbidden too, and is no second password field.
    const forgot: El = { role: 'link', name: 'Forgot password?', context: '', canType: false, disabled: false, forbidden: true }
    expect(signInPage({ url: 'https://example.com/login', text: 'Sign in', elements: [field('Username or email address'), password(), forgot, button('Sign in')] })).toBe('example.com')
    // A sign-in form above a sign-up form, on a sign-in address: the one known password decides.
    expect(signInPage({ url: 'https://news.example.com/login', text: 'Login Create Account', elements: [password(''), forgot, password('', { secretKind: 'new-password' })] })).toBe('news.example.com')
  })

  it('the first step of a two-step sign-in: an account field and a way on, on a sign-in address', () => {
    const step = [field('Email or phone', { input: { type: 'email', autocomplete: 'username' } }), button('Next')]
    expect(signInPage({ url: 'https://accounts.example.com/v3/signin/identifier', text: 'Sign in', elements: step })).toBe('accounts.example.com')
    // The same form on an ordinary address is a newsletter box, not a sign-in.
    expect(signInPage({ url: 'https://example.com/news', text: 'Sign in', elements: step })).toBeNull()
    expect(signInPage({ url: 'https://example.com/login', text: 'Sign in', elements: [field('Email')] })).toBeNull()
    expect(signInPage({ url: 'https://example.com/sessions', text: LONG, elements: step })).toBeNull()
    // The way on is disabled until the account is typed.
    expect(signInPage({ url: 'https://app.example.com/login', text: 'Log in', elements: [field('Email', { input: { type: 'email', autocomplete: '' } }), { ...button('Continue'), disabled: true }] })).toBe('app.example.com')
    // Only other accounts are offered.
    expect(signInPage({ url: 'https://app.example.com/login', text: 'Log in', elements: [button('Log in with GitHub'), button('Log in with Google')] })).toBe('app.example.com')
    expect(signInPage({ url: 'https://example.com/pricing', text: 'Plans', elements: [button('Log in with GitHub')] })).toBeNull()
  })

  it('never a sign-up, a password change, or a long page that carries a sign-in box beside its content', () => {
    expect(signInPage({ url: 'https://example.com/welcome', text: '', elements: [password('Password'), password('Confirm password')] })).toBeNull()
    expect(signInPage({ url: 'https://example.com/settings', text: 'Security', elements: [password('New password')] })).toBeNull()
    // A password being chosen: the field says so, or the address does.
    expect(signInPage({ url: 'https://example.com/welcome', text: 'Create your account', elements: [field('Email'), password('Password', { secretKind: 'new-password' })] })).toBeNull()
    for (const path of ['/signup', '/register', '/users/sign_up', '/account/reset-password', '/forgot-password'])
      expect(signInPage({ url: `https://example.com${path}`, text: '', elements: [field('Email'), password(), button('Continue')] }), path).toBeNull()
    expect(signInPage({ url: 'https://forum.example.com/t/42', text: LONG, elements: [field('Username'), password(), button('Log in')] })).toBeNull()
    expect(signInPage({ url: 'https://example.com/login', text: '', elements: [password('Password', { disabled: true })] })).toBeNull()
    // A password change away from a sign-in address, and one with a confirmation anywhere.
    expect(signInPage({ url: 'https://example.com/settings/security', text: 'Security', elements: [password('Current password'), password('Password', { secretKind: 'new-password' })] })).toBeNull()
    expect(signInPage({ url: 'https://example.com/login', text: '', elements: [password(), password('A', { secretKind: 'new-password' }), password('B', { secretKind: 'new-password' })] })).toBeNull()
    // A card number is forbidden too, and is no password.
    expect(signInPage({ url: 'https://shop.example.com/pay', text: 'Pay', elements: [field('Card number', { forbidden: true, input: undefined })] })).toBeNull()
  })

  it('never a task that was sent to a sign-in page on purpose, and never an address that is no web page', () => {
    const elements = [field('Email'), password(), button('Sign in')]
    expect(signInPage({ url: 'https://example.com/login', text: '', elements }, 'https://example.com/login')).toBeNull()
    expect(signInPage({ url: 'https://example.com/login', text: '', elements }, 'https://example.com/orders')).toBe('example.com')
    expect(signInPage({ url: 'about:blank', text: '', elements })).toBeNull()
    expect(signInPage({ url: 'not a url', elements })).toBeNull()
    expect(signInPage({})).toBeNull()
  })
})
