import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { decodeXmlText, drawingParagraphs, readPptxSlides, resolvePartPath, slideImageType } from '../pptx-slides'

const slideXml = (paras: string[], blip?: string) =>
  `<p:sld><p:cSld><p:spTree>${paras.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}${
    blip ? `<p:pic><p:blipFill><a:blip r:embed="${blip}"/></p:blipFill></p:pic>` : ''
  }</p:spTree></p:cSld></p:sld>`

async function deck(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>',
  )
  zip.file('ppt/slides/slide1.xml', slideXml(['Second title', 'A &amp; B']))
  zip.file('ppt/slides/slide2.xml', slideXml(['Opening', 'Point one'], 'rId5'))
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    '<Relationships><Relationship Id="rId5" Type="x/image" Target="../media/image1.png"/><Relationship Id="rId6" Type="x/notesSlide" Target="../notesSlides/notesSlide2.xml"/><Relationship Id="rId7" Type="x/image" Target="https://example.com/a.png" TargetMode="External"/></Relationships>',
  )
  zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>')
  zip.file('ppt/media/image1.png', new Uint8Array([137, 80, 78, 71]))
  return zip.generateAsync({ type: 'uint8array' })
}

describe('readPptxSlides', () => {
  it('reads slides in the deck’s own order, with text, pictures and notes', async () => {
    const { slides, truncated } = await readPptxSlides(await deck())
    expect(truncated).toBe(false)
    expect(slides.map((s) => s.paragraphs)).toEqual([
      ['Opening', 'Point one'],
      ['Second title', 'A & B'],
    ])
    expect(slides[0].images).toEqual(['ppt/media/image1.png'])
    expect(slides[0].notes).toBe('Say hello')
    expect(slides.map((s) => s.number)).toEqual([1, 2])
  })

  it('refuses a file that is not a presentation, in a sentence', async () => {
    await expect(readPptxSlides(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PowerPoint/)
  })
})

describe('the helpers', () => {
  it('decodes XML entities', () => {
    expect(decodeXmlText('a &lt;b&gt; &#233; &#x41; &unknown;')).toBe('a <b> é A &unknown;')
  })

  it('joins runs into paragraphs, keeping line breaks', () => {
    expect(drawingParagraphs('<a:p><a:r><a:t>One</a:t></a:r><a:br/><a:r><a:t>Two</a:t></a:r></a:p><a:p></a:p>')).toEqual(['One\nTwo'])
  })

  it('resolves a part path and never escapes the archive', () => {
    expect(resolvePartPath('ppt/slides', '../media/a.png')).toBe('ppt/media/a.png')
    expect(resolvePartPath('ppt/slides', '../../../../etc/passwd')).toBeNull()
    expect(resolvePartPath('ppt/slides', 'https://example.com/x')).toBeNull()
  })

  it('shows only picture types a browser draws safely', () => {
    expect(slideImageType('ppt/media/a.PNG')).toBe('image/png')
    expect(slideImageType('ppt/media/a.emf')).toBeNull()
    expect(slideImageType('ppt/media/a.svg')).toBeNull()
  })
})
