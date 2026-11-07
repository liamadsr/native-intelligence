export const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  'png','jpg','jpeg','gif','webp','svg','heic','heif',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'txt','csv','md','json',
  'js','ts','tsx','jsx','py','rb','go','rs','java','kt','swift',
  'c','cpp','h','hpp','css','scss','html','xml','yaml','yml','toml',
  'sh','sql','r','lua','php','env','log','conf','cfg','ini',
])

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export const MAX_ATTACHMENT_LABEL = '50MB'

export const ATTACHMENT_ACCEPT_ATTR = Array.from(ALLOWED_ATTACHMENT_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(',')

export function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0 || idx === name.length - 1) return ''
  return name.slice(idx + 1).toLowerCase()
}

export function isAllowedAttachmentFile(
  file: { name: string; size: number },
): { ok: true } | { ok: false; reason: string } {
  const ext = getFileExtension(file.name)
  if (!ext) {
    return { ok: false, reason: `"${file.name}" has no file extension.` }
  }
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `.${ext} files aren't supported. Use images, PDFs, documents, or code files.` }
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return { ok: false, reason: `"${file.name}" is ${mb}MB. The maximum size is ${MAX_ATTACHMENT_LABEL}.` }
  }
  return { ok: true }
}

export function fileCategory(mime: string): 'image' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  return 'document'
}
