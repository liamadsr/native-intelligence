import { describe, expect, it } from 'vitest'
import { jsonContentToMarkdown, markdownToJSONContent, TAG_NODE } from '@/app/account/(dashboard)/views/markdown-conversion'

const ID = '33333333-3333-4333-8333-333333333333'

describe('tag pills in markdown conversion', () => {
  it('reads a tag link as a pill and writes it back', () => {
    const md = `Ship it [#Renewal](tag://${ID}) now`
    const doc = markdownToJSONContent(md)
    const para = doc.content?.[0]
    expect(para?.content?.map((n) => n.type)).toEqual(['text', TAG_NODE, 'text'])
    expect(para?.content?.[1].attrs).toEqual({ id: ID, name: 'Renewal' })
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })

  it('keeps a pill inside bold', () => {
    const md = `**urgent [#Renewal](tag://${ID})**`
    expect(jsonContentToMarkdown(markdownToJSONContent(md))).toBe(md)
  })

  it('leaves a tag link in code as code', () => {
    const md = `\`[#x](tag://${ID})\``
    const para = markdownToJSONContent(md).content?.[0]
    expect(para?.content?.[0].marks?.[0].type).toBe('code')
    expect(jsonContentToMarkdown(markdownToJSONContent(md))).toBe(md)
  })

  it('a heading is still a heading', () => {
    expect(markdownToJSONContent('# Title').content?.[0].type).toBe('heading')
  })
})
