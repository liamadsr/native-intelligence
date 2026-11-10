import { describe, it, expect } from 'vitest'
import { parseSkillMd, serializeSkillMd } from '@/lib/library/skill-md'

describe('parseSkillMd', () => {
  it('parses standard frontmatter + body', () => {
    const text = [
      '---',
      'name: weekly-planner',
      'description: Plans your week',
      '---',
      '',
      '# Instructions',
      '',
      'Do the thing.',
    ].join('\n')

    const result = parseSkillMd(text)
    expect(result.name).toBe('weekly-planner')
    expect(result.description).toBe('Plans your week')
    expect(result.body).toBe('# Instructions\n\nDo the thing.')
    expect(result.warnings).toEqual([])
  })

  it('trims name and description values', () => {
    const text = ['---', 'name:   spaced-name   ', 'description:   padded  ', '---', 'body'].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('spaced-name')
    expect(result.description).toBe('padded')
  })

  it('treats the whole file as body when frontmatter is missing', () => {
    const text = '# Just a heading\n\nNo frontmatter here.'
    const result = parseSkillMd(text)
    expect(result.name).toBe('')
    expect(result.description).toBe('')
    expect(result.body).toBe('# Just a heading\n\nNo frontmatter here.')
    expect(result.warnings).toContain(
      'No frontmatter found — imported the whole file as instructions',
    )
  })

  it('treats the file as body when the opening delimiter is missing (malformed)', () => {
    // A `---` that is NOT the opening line is not a frontmatter block.
    const text = 'some preamble\n---\nname: x\n---\nbody'
    const result = parseSkillMd(text)
    expect(result.name).toBe('')
    expect(result.warnings.length).toBe(1)
    expect(result.body).toContain('some preamble')
  })

  it('treats the file as body when the closing delimiter is missing', () => {
    const text = '---\nname: unclosed\ndescription: no end\n\nstill body'
    const result = parseSkillMd(text)
    expect(result.name).toBe('')
    expect(result.body).toContain('name: unclosed')
    expect(result.warnings).toContain(
      'No frontmatter found — imported the whole file as instructions',
    )
  })

  it('unquotes double-quoted values with escapes', () => {
    const text = ['---', 'name: "quoted-name"', 'description: "Say \\"hi\\" to \\\\ them"', '---', 'b'].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('quoted-name')
    expect(result.description).toBe('Say "hi" to \\ them')
  })

  it('unquotes single-quoted values with YAML escaping', () => {
    const text = ["---", "name: 'planner'", "description: 'it''s useful'", '---', 'b'].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('planner')
    expect(result.description).toBe("it's useful")
  })

  it('drops allowed-tools with the tool-access warning', () => {
    const text = [
      '---',
      'name: skill',
      'description: d',
      'allowed-tools: Read, Write',
      '---',
      'b',
    ].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('skill')
    expect(result.warnings).toContain(
      'allowed-tools is not imported — set tool access in Native Intelligence after import',
    )
  })

  it('drops other recognized-but-unsupported keys with a generic warning', () => {
    const text = [
      '---',
      'name: skill',
      'description: d',
      'license: MIT',
      '---',
      'b',
    ].join('\n')
    const result = parseSkillMd(text)
    expect(result.warnings).toContain('license is not imported')
    expect(result.warnings).not.toContain('name is not imported')
  })

  it('drops unknown keys and does not double-warn on duplicates', () => {
    const text = [
      '---',
      'name: skill',
      'custom: one',
      'custom: two',
      '---',
      'b',
    ].join('\n')
    const result = parseSkillMd(text)
    const customWarnings = result.warnings.filter((w) => w.startsWith('custom '))
    expect(customWarnings).toEqual(['custom is not imported'])
  })

  it('ignores nested/sequence YAML under an unsupported key gracefully', () => {
    const text = [
      '---',
      'name: skill',
      'description: d',
      'metadata:',
      '  version: 1',
      '  tags:',
      '    - a',
      '    - b',
      '---',
      'body',
    ].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('skill')
    expect(result.description).toBe('d')
    expect(result.body).toBe('body')
    // Only the parent `metadata` key warns; its nested children are ignored.
    expect(result.warnings).toEqual(['metadata is not imported'])
  })

  it('handles CRLF line endings', () => {
    const text = '---\r\nname: crlf\r\ndescription: works\r\n---\r\n\r\nbody line'
    const result = parseSkillMd(text)
    expect(result.name).toBe('crlf')
    expect(result.description).toBe('works')
    expect(result.body).toBe('body line')
  })

  it('ignores frontmatter comments and blank lines', () => {
    const text = ['---', '# a comment', '', 'name: skill', '---', 'body'].join('\n')
    const result = parseSkillMd(text)
    expect(result.name).toBe('skill')
    expect(result.warnings).toEqual([])
  })
})

describe('serializeSkillMd', () => {
  it('emits standard frontmatter and verbatim body', () => {
    const out = serializeSkillMd({
      slug: 'weekly-planner',
      description: 'Plans your week',
      body: '# Instructions\n\nDo the thing.',
    })
    expect(out).toBe(
      [
        '---',
        'name: weekly-planner',
        'description: Plans your week',
        '---',
        '',
        '# Instructions',
        '',
        'Do the thing.',
        '',
      ].join('\n'),
    )
  })

  it('never emits custom frontmatter keys', () => {
    const out = serializeSkillMd({
      slug: 's',
      description: 'd',
      body: 'b',
      extraSections: [{ heading: 'Standing instructions', lines: ['- rule one'] }],
    })
    const frontmatter = out.split('\n---\n')[0]
    expect(frontmatter).toBe('---\nname: s\ndescription: d')
    // The extra content lands in the body, not the frontmatter.
    expect(out).toContain('## Standing instructions')
    expect(out).toContain('- rule one')
  })

  it('appends extraSections as ## headings with their lines', () => {
    const out = serializeSkillMd({
      slug: 's',
      description: 'd',
      body: 'Body text.',
      extraSections: [
        { heading: 'Standing instructions', lines: ['- always X', '- never Y'] },
        { heading: 'Response style', lines: ['Use a friendly tone.'] },
      ],
    })
    expect(out).toContain('Body text.\n\n## Standing instructions\n\n- always X\n- never Y')
    expect(out).toContain('## Response style\n\nUse a friendly tone.')
  })

  it('skips empty extraSections', () => {
    const out = serializeSkillMd({
      slug: 's',
      description: 'd',
      body: 'Body.',
      extraSections: [{ heading: 'Empty', lines: [] }],
    })
    expect(out).not.toContain('## Empty')
  })

  it('quotes YAML-significant values on the way out', () => {
    const out = serializeSkillMd({
      slug: 'planner',
      description: 'Plans: your week, with #tags',
      body: 'b',
    })
    expect(out).toContain('name: planner')
    expect(out).toContain('description: "Plans: your week, with #tags"')
  })

  it('escapes backslashes and quotes in frontmatter values', () => {
    const out = serializeSkillMd({
      slug: 's',
      description: 'a "quote" and a \\ slash',
      body: 'b',
    })
    expect(out).toContain('description: "a \\"quote\\" and a \\\\ slash"')
  })

  it('quotes empty and reserved-word values', () => {
    expect(serializeSkillMd({ slug: 's', description: '', body: 'b' })).toContain(
      'description: ""',
    )
    expect(serializeSkillMd({ slug: 'true', description: 'd', body: 'b' })).toContain(
      'name: "true"',
    )
    expect(serializeSkillMd({ slug: '123', description: 'd', body: 'b' })).toContain(
      'name: "123"',
    )
  })

  it('ends with exactly one trailing newline', () => {
    const out = serializeSkillMd({ slug: 's', description: 'd', body: 'b\n\n\n' })
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})

describe('round-trip', () => {
  it('serialize → parse recovers description and body', () => {
    const description = 'A skill that does: things #hash "quoted"'
    const body = '# Header\n\nStep one.\n\nStep two.'
    const serialized = serializeSkillMd({ slug: 'my-skill', description, body })

    const parsed = parseSkillMd(serialized)
    expect(parsed.name).toBe('my-skill')
    expect(parsed.description).toBe(description)
    expect(parsed.body).toBe(body)
    expect(parsed.warnings).toEqual([])
  })

  it('round-trips single-quote-bearing descriptions', () => {
    const description = "it's a skill"
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('round-trips a description containing a newline', () => {
    const description = 'line one\nline two'
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('round-trips a description containing a tab', () => {
    const description = 'left\tright'
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('round-trips a description containing a carriage return', () => {
    // A bare \r survives serialize/escape; note parseSkillMd normalizes \r\n
    // pairs up front, so we use a lone \r (not preceded by \n) here.
    const description = 'before\rafter'
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('round-trips a multiline description with several control chars', () => {
    const description = 'one\ntwo\tindented\nthree'
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('keeps a literal backslash-n distinct from a real newline', () => {
    // The user typed the two characters backslash + n, NOT a newline. It must
    // round-trip as those two chars, not decode into a line break.
    const description = 'a\\nb'
    const serialized = serializeSkillMd({ slug: 's', description, body: 'b' })
    const parsed = parseSkillMd(serialized)
    expect(parsed.description).toBe(description)
  })

  it('never writes a raw newline inside a frontmatter value line', () => {
    const serialized = serializeSkillMd({
      slug: 's',
      description: 'has\na newline',
      body: 'body',
    })
    // The frontmatter block is everything between the opening and closing `---`.
    const closeIdx = serialized.indexOf('\n---\n')
    const frontmatter = serialized.slice(0, closeIdx)
    // Exactly three lines: opening `---`, name, description. A raw newline inside
    // the description value would push the value onto a broken extra line.
    const lines = frontmatter.split('\n')
    expect(lines).toEqual([
      '---',
      'name: s',
      'description: "has\\na newline"',
    ])
    // And the serialized description line carries the escaped sequence, not a
    // literal control character.
    expect(frontmatter).not.toContain('has\na newline')
  })
})
