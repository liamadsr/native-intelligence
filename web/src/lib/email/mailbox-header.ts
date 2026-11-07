/** Render structured provider names as a mailbox header without creating extra recipients. */
export function formatMailbox(name: string | null | undefined, address: string): string {
  if (!address) return ''
  const displayName = name?.replace(/[\r\n\t]+/g, ' ').trim()
  if (!displayName) return address
  const quoted = /[()<>[\]:;@\\,.\"]/.test(displayName)
    ? `"${displayName.replace(/[\\"]/g, '\\$&')}"`
    : displayName
  return `${quoted} <${address}>`
}
