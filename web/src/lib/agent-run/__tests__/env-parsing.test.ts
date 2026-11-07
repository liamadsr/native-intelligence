import { describe, it, expect } from 'vitest'
import { parseEnvText, stringifyEnv } from '../env-parsing'

describe('parseEnvText', () => {
  it('returns {} for empty / nullish input', () => {
    expect(parseEnvText('')).toEqual({})
    expect(parseEnvText(null)).toEqual({})
    expect(parseEnvText(undefined)).toEqual({})
    expect(parseEnvText('   \n\n  ')).toEqual({})
  })

  it('parses basic KEY=VALUE pairs', () => {
    expect(parseEnvText('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('trims whitespace around key and value', () => {
    expect(parseEnvText('  FOO  =  bar  ')).toEqual({ FOO: 'bar' })
  })

  it('ignores blank lines and full-line comments', () => {
    const text = '# a comment\n\nFOO=bar\n   # indented comment\nBAZ=qux\n'
    expect(parseEnvText(text)).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('strips a leading `export `', () => {
    expect(parseEnvText('export FOO=bar')).toEqual({ FOO: 'bar' })
  })

  it('strips an unquoted inline comment but keeps `#` inside a value', () => {
    expect(parseEnvText('FOO=bar # trailing')).toEqual({ FOO: 'bar' })
    expect(parseEnvText('FOO=pass#1')).toEqual({ FOO: 'pass#1' })
  })

  it('handles double-quoted values with escapes and inner `#`', () => {
    expect(parseEnvText('FOO="hello world"')).toEqual({ FOO: 'hello world' })
    expect(parseEnvText('FOO="a # b"')).toEqual({ FOO: 'a # b' })
    expect(parseEnvText('FOO="line1\\nline2"')).toEqual({ FOO: 'line1\nline2' })
    expect(parseEnvText('FOO="he said \\"hi\\""')).toEqual({ FOO: 'he said "hi"' })
  })

  it('treats single quotes as literal (no escape processing)', () => {
    expect(parseEnvText("FOO='a # b'")).toEqual({ FOO: 'a # b' })
    expect(parseEnvText("FOO='line1\\nline2'")).toEqual({ FOO: 'line1\\nline2' })
  })

  it('keeps `=` characters inside the value', () => {
    expect(parseEnvText('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' })
  })

  it('allows an empty value', () => {
    expect(parseEnvText('EMPTY=')).toEqual({ EMPTY: '' })
  })

  it('skips malformed lines (no `=`, junk keys)', () => {
    expect(parseEnvText('NOEQUALS\nFOO=bar\n123=nope\nBAD KEY=x')).toEqual({ FOO: 'bar' })
  })

  it('last definition of a key wins', () => {
    expect(parseEnvText('FOO=one\nFOO=two')).toEqual({ FOO: 'two' })
  })
})

describe('stringifyEnv', () => {
  it('emits bare KEY=VALUE for safe values, in insertion order', () => {
    expect(stringifyEnv({ FOO: 'bar', BAZ: 'qux' })).toBe('FOO=bar\nBAZ=qux')
  })

  it('emits an empty value with no quotes', () => {
    expect(stringifyEnv({ EMPTY: '' })).toBe('EMPTY=')
  })

  it('quotes values needing it', () => {
    expect(stringifyEnv({ FOO: 'hello world' })).toBe('FOO="hello world"')
    expect(stringifyEnv({ FOO: 'a # b' })).toBe('FOO="a # b"')
  })
})

describe('round-trip', () => {
  it('stringify → parse preserves tricky values', () => {
    const map = {
      SIMPLE: 'value',
      SPACED: 'has spaces',
      HASH: 'a # b',
      QUOTE: 'he said "hi"',
      NEWLINE: 'line1\nline2',
      EMPTY: '',
      LITERAL_HASH: 'pass#1',
    }
    expect(parseEnvText(stringifyEnv(map))).toEqual(map)
  })

  // Regression: a literal backslash adjacent to n/r/t/" must NOT be mis-decoded.
  // Earlier the unescape ran `\n→newline` before collapsing `\\→\`, corrupting
  // values like a Windows path or a regex token.
  it('preserves backslashes adjacent to escape chars (no unescape-order corruption)', () => {
    const map = {
      WINPATH: 'C:\\new',      // backslash + "new" — the canonical breakage
      WINPATH2: 'C:\\temp\\run',
      LITERAL_BACKSLASH_N: 'a\\nb', // literal backslash-n, not a newline
      TAB_THEN_T: 'tab\\there',
      REAL_NEWLINE: 'a\nb',    // an actual newline still round-trips
      TRAILING_SLASH: 'ends\\',
      MIXED: 'path C:\\x and\nnewline',
    }
    expect(parseEnvText(stringifyEnv(map))).toEqual(map)
  })

  it('decodes recognized escapes and keeps the char on unknown escapes', () => {
    expect(parseEnvText('A="x\\ny"')).toEqual({ A: 'x\ny' })   // \n → newline
    expect(parseEnvText('A="x\\\\ny"')).toEqual({ A: 'x\\ny' }) // \\ then n → backslash + "n"
    expect(parseEnvText('A="x\\qy"')).toEqual({ A: 'xqy' })     // unknown \q → q
  })
})

describe('parseEnvText — quoted value with an inline comment', () => {
  it('drops the comment and the quotes, and still decodes escapes', () => {
    expect(
      parseEnvText(
        'API_URL="https://x.example" # prod\nNAME=\'a b\'   # note\nMSG="say \\"hi\\"" # c\nHASH="pass#1"',
      ),
    ).toEqual({ API_URL: 'https://x.example', NAME: 'a b', MSG: 'say "hi"', HASH: 'pass#1' })
  })
})
