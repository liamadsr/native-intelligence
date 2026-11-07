/**
 * Convert user-typed plain text into a safe HTML email body.
 *
 * Every line is HTML-escaped (so `<`, `>`, `&`, quotes typed by a human land as
 * literal text, not markup) and then wrapped in a `<p>`. Blank lines become
 * `<p><br/></p>` so paragraph spacing survives. The whole thing is wrapped in a
 * styled container matching the compose shells that previously interpolated raw
 * text.
 *
 * This is the single escaping seam for compose paths that hand-build body_html;
 * the send API does not sanitize, so escaping MUST happen here.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function plainTextToHtml(text: string): string {
  const body = text
    .split('\n')
    .map((line) => `<p>${line ? escapeHtml(line) : '<br/>'}</p>`)
    .join('')
  return `<div style="font-family: sans-serif; line-height: 1.5;">${body}</div>`
}
