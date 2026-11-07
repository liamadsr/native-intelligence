/**
 * The phone field's formatting, as you type (components/communication/
 * phone-section.tsx). Dial8 texts US and Canadian numbers only
 * (lib/twilio/phone.ts isNanpNumber), so the field holds the ten national
 * digits behind a fixed +1 and shows them the usual way: (555) 123-4567.
 * Client-safe: no server imports.
 */

/** The ten national digits in what was typed or pasted: "+1 (555) 123-4567", "15551234567" and "555.123.4567" all give 5551234567. */
export function nanpDigits(input: string): string {
  let digits = input.replace(/\D/g, '')
  // A pasted +1 or leading 1 (eleven digits): the country code, not the number.
  if (digits.length > 10 && digits.startsWith('1')) digits = digits.slice(1)
  return digits.slice(0, 10)
}

/** Up to ten digits, shown as far as they go: "(555", "(555) 12", "(555) 123-4567". */
export function formatNanp(digits: string): string {
  if (!digits) return ''
  const area = digits.slice(0, 3)
  const exchange = digits.slice(3, 6)
  const line = digits.slice(6, 10)
  if (digits.length <= 3) return `(${area}`
  if (digits.length <= 6) return `(${area}) ${exchange}`
  return `(${area}) ${exchange}-${line}`
}

/** A full number Dial8 can text: ten digits, area code and exchange not starting 0 or 1. */
export function isCompleteNanp(digits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits)
}

/** Ten digits whose area code or exchange can't be a real number (starts 0 or 1). */
export function isImpossibleNanp(digits: string): boolean {
  return (digits.length >= 1 && /^[01]/.test(digits)) || (digits.length >= 4 && /^[01]/.test(digits.slice(3)))
}

/** The number to send the API: +1 and the ten digits. */
export function nanpE164(digits: string): string {
  return `+1${digits}`
}

/** "+15551234567" as "+1 (555) 123-4567"; any other number as it is. */
export function formatE164ForDisplay(e164: string): string {
  return /^\+1\d{10}$/.test(e164) ? `+1 ${formatNanp(e164.slice(2))}` : e164
}

/** Where the caret goes in `formatted` to sit after its first `count` digits (an edit mid-number keeps its place). */
export function caretAfterDigits(formatted: string, count: number): number {
  if (count <= 0) return formatted.startsWith('(') ? 1 : 0
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]) && ++seen === count) return i + 1
  }
  return formatted.length
}

/**
 * The digits after an edit. Deleting only a bracket, space or dash (backspace
 * just past one) deletes the digit before it instead, as a person means: the
 * formatting would otherwise put it straight back and the caret would stick.
 */
export function digitsAfterEdit(previousDigits: string, nextValue: string, caret: number | null): { digits: string; caretDigits: number } {
  let digits = nanpDigits(nextValue)
  let caretDigits = caret === null ? digits.length : nanpDigits(nextValue.slice(0, caret)).length
  const previousFormatted = formatNanp(previousDigits)
  if (digits === previousDigits && nextValue.length < previousFormatted.length && caretDigits > 0) {
    digits = previousDigits.slice(0, caretDigits - 1) + previousDigits.slice(caretDigits)
    caretDigits -= 1
  }
  return { digits, caretDigits: Math.min(caretDigits, digits.length) }
}

/**
 * What a QR code holds to start a text: the standard SMSTO form, which the
 * iPhone's and Android's cameras open in Messages, to `e164`, with `body`
 * typed in, ready to send.
 */
export function smsQrPayload(e164: string, body: string): string {
  return `SMSTO:${e164}:${body}`
}

/** A link that opens Messages to `e164` with `body` typed in (on a phone; `?&body=` reads on iOS and Android both). */
export function smsHref(e164: string, body: string): string {
  return `sms:${e164}?&body=${encodeURIComponent(body)}`
}
