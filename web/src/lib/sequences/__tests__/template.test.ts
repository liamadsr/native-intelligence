import { describe, it, expect } from 'vitest'
import { renderTemplate, extractTokens, buildTemplateVars } from '@/lib/sequences/template'

describe('renderTemplate', () => {
  it('substitutes known tokens', () => {
    const r = renderTemplate('Hi {{first_name}}, greetings from {{sender_first_name}}!', {
      first_name: 'Sarah',
      sender_first_name: 'Liam',
    })
    expect(r.text).toBe('Hi Sarah, greetings from Liam!')
    expect(r.unresolved).toEqual([])
  })

  it('is case-insensitive on token names', () => {
    const r = renderTemplate('Hi {{First_Name}}', { first_name: 'Sarah' })
    expect(r.text).toBe('Hi Sarah')
  })

  it('uses inline fallbacks for missing values', () => {
    const r = renderTemplate('Hi {{first_name|there}}, how is {{company|your company}}?', {})
    expect(r.text).toBe('Hi there, how is your company?')
    expect(r.unresolved).toEqual([])
  })

  it('treats empty-string values as missing (fallback applies)', () => {
    const r = renderTemplate('Hi {{first_name|there}}', { first_name: '  ' })
    expect(r.text).toBe('Hi there')
  })

  it('reports unresolved tokens without a fallback, deduplicated', () => {
    const r = renderTemplate('{{first_name}} and {{FIRST_NAME}} and {{company}}', {})
    expect(r.unresolved).toEqual(['first_name', 'company'])
    expect(r.text).toContain('{{first_name}}')
  })

  it('HTML-escapes substituted values by default', () => {
    const r = renderTemplate('Hi {{first_name}}', { first_name: '<script>alert(1)</script>' })
    expect(r.text).toBe('Hi &lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes single quotes (value cannot terminate a single-quoted attribute)', () => {
    const r = renderTemplate('{{first_name}}', { first_name: "x' onmouseover='alert(1)" })
    expect(r.text).toBe('x&#39; onmouseover=&#39;alert(1)')
  })

  it('can skip escaping for plain-text contexts (subjects)', () => {
    const r = renderTemplate('Intro: {{company}}', { company: 'A&B' }, { escape: false })
    expect(r.text).toBe('Intro: A&B')
  })

  it('re-emits unresolved tokens with their ORIGINAL text (source-matching)', () => {
    const r = renderTemplate('Hi {{First_Name}}', {})
    expect(r.text).toBe('Hi {{First_Name}}')
    expect(r.unresolved).toEqual(['first_name'])
  })

  it('blocks on hyphenated (invalid-grammar) tokens', () => {
    const r = renderTemplate('Hi {{first-name}}', { first_name: 'Sarah' })
    expect(r.unresolved).toContain('malformed:{{first-name}}')
    expect(r.text).toContain('{{first-name}}')
  })

  it('blocks on unclosed braces', () => {
    const r = renderTemplate('Hi {{first_name', { first_name: 'Sarah' })
    expect(r.unresolved.some((u) => u.startsWith('malformed:'))).toBe(true)
  })

  it('blocks on nested braces even when the inner token resolves', () => {
    const r = renderTemplate('{{a {{b}}}}', { b: 'B' })
    expect(r.unresolved.some((u) => u.startsWith('malformed:'))).toBe(true)
  })

  it('blocks on nested braces with an unresolved inner token', () => {
    const r = renderTemplate('{{a {{b}}}}', {})
    expect(r.unresolved).toContain('b')
    expect(r.unresolved.some((u) => u.startsWith('malformed:'))).toBe(true)
  })

  it('treats an empty fallback as no fallback', () => {
    const r = renderTemplate('Hi {{t|}}', {})
    expect(r.unresolved).toEqual(['t'])
    expect(r.text).toBe('Hi {{t|}}')
  })

  it('treats a whitespace-only fallback as no fallback', () => {
    const r = renderTemplate('Hi {{t|   }}', {})
    expect(r.unresolved).toEqual(['t'])
  })

  it('guarantees no brace residue when unresolved is empty', () => {
    const cases = ['Hi {{first_name}}', '{{a {{b}}}}', '{{first_name', 'x}}y', 'plain text']
    for (const template of cases) {
      const r = renderTemplate(template, { first_name: 'Sarah', b: 'B' })
      if (r.unresolved.length === 0) {
        expect(r.text).not.toContain('{{')
        expect(r.text).not.toContain('}}')
      }
    }
  })
})

describe('extractTokens', () => {
  it('lists unique lowercased token names', () => {
    expect(extractTokens('{{First_Name}} {{company|X}} {{first_name}}')).toEqual([
      'first_name',
      'company',
    ])
  })
})

describe('buildTemplateVars', () => {
  it('derives first name from full_name when missing', () => {
    const vars = buildTemplateVars(
      { full_name: 'Sarah Guo', email: 's@conviction.com' },
      { name: 'Liam Alizadeh' },
    )
    expect(vars.first_name).toBe('Sarah')
    expect(vars.sender_first_name).toBe('Liam')
  })

  it('falls back to the sender email local part for sender name', () => {
    const vars = buildTemplateVars({}, { email: 'liam@dial8.ai' })
    expect(vars.sender_name).toBe('liam')
  })

  it('treats whitespace-only names as missing', () => {
    const vars = buildTemplateVars({ full_name: '   ' }, { name: '  ' })
    expect(vars.full_name).toBeNull()
    expect(vars.first_name).toBeNull()
    expect(vars.sender_name).toBeNull()
    expect(vars.sender_first_name).toBeNull()
  })
})

describe('buildTemplateVars sender identity', () => {
  const contact = { first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' }

  it('uses the human name, not the provider label', () => {
    // Regression: the engine passed connected_account.display_name, which is
    // hardcoded to the PROVIDER ('Gmail'/'Outlook'), so {{sender_first_name}}
    // signed real investor mail as "Gmail".
    const vars = buildTemplateVars(contact, {
      name: 'Liam Alizadeh',
      email: 'liam@dial8.ai',
    })
    expect(vars.sender_first_name).toBe('Liam')
    expect(vars.sender_name).toBe('Liam Alizadeh')
  })

  it('falls back to the mailbox local-part when the member has no name', () => {
    const vars = buildTemplateVars(contact, { name: null, email: 'liam@dial8.ai' })
    expect(vars.sender_first_name).toBe('liam')
  })
})
