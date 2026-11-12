/**
 * The one error every Google read in the SEO area throws on purpose: a code
 * from view.ts's closed list and a sentence a person can act on. Google's own
 * words (status bodies, reasons) never reach the message: they go to the logs
 * through `detail`.
 */
import {
  GOOGLE_PRODUCT_LABEL,
  type GoogleProduct,
  type GoogleSeoErrorCode,
  type GoogleSeoErrorDetails,
} from './view'

export class GoogleSeoError extends Error {
  constructor(
    public readonly code: GoogleSeoErrorCode,
    public readonly product: GoogleProduct,
    message: string,
    public readonly extra: {
      reconnectBy?: GoogleSeoErrorDetails['reconnect_by']
      retryAfterSeconds?: number | null
      /** For the logs only: status, Google's reason. */
      detail?: string
    } = {},
  ) {
    super(message)
    this.name = 'GoogleSeoError'
  }

  details(): GoogleSeoErrorDetails {
    return {
      product: this.product,
      ...(this.extra.reconnectBy !== undefined
        ? { reconnect_by: this.extra.reconnectBy }
        : {}),
      ...(this.extra.retryAfterSeconds !== undefined
        ? { retry_after_seconds: this.extra.retryAfterSeconds }
        : {}),
    }
  }
}

export function isGoogleSeoError(error: unknown): error is GoogleSeoError {
  return error instanceof GoogleSeoError
}

/** The product's name in a sentence. */
export function productName(product: GoogleProduct): string {
  return GOOGLE_PRODUCT_LABEL[product]
}

/** Nobody here connected it: the caller connects their own. */
export function notConnected(product: GoogleProduct): GoogleSeoError {
  return new GoogleSeoError(
    'NOT_CONNECTED',
    product,
    `${productName(product)} isn’t connected yet. Connect it first (read only).`,
  )
}

/** Connected, nothing chosen for the workspace yet. */
export function noSource(product: GoogleProduct): GoogleSeoError {
  return product === 'search_console'
    ? new GoogleSeoError(
        'NO_SOURCE',
        product,
        'No Search Console site is chosen for this workspace yet. Choose one first.',
      )
    : new GoogleSeoError(
        'NO_SOURCE',
        product,
        'No Google Analytics property is chosen for this workspace yet. Choose one first.',
      )
}

/**
 * The connection the reads go through needs a fresh sign-in. `who` is the
 * member whose connection it is; the sentence says whether that is the
 * caller.
 */
/**
 * The member whose connection the reads go through is no longer a full
 * member of the workspace (they left, were removed, or are now a guest): the
 * workspace stops reading through their connection at once. Someone else
 * chooses again through their own.
 */
export function chooserGone(
  product: GoogleProduct,
  who: { user_id: string | null; name: string | null; is_you: boolean } | null,
): GoogleSeoError {
  const name = productName(product)
  return new GoogleSeoError(
    'RECONNECT_NEEDED',
    product,
    `The teammate who chose this ${name} source is no longer a member of the workspace, so it is no longer read. Anyone with access can choose it again through their own ${name} connection.`,
    { reconnectBy: who, detail: 'chooser left' },
  )
}

export function reconnectNeeded(
  product: GoogleProduct,
  who: { user_id: string | null; name: string | null; is_you: boolean } | null,
  detail?: string,
): GoogleSeoError {
  const name = productName(product)
  const message = !who
    ? `The ${name} connection needs a fresh sign-in. Reconnect ${name}.`
    : who.is_you
      ? `Your ${name} connection needs a fresh sign-in (it was removed, switched off, or Google stopped accepting it). Reconnect ${name}, then try again.`
      : `${who.name ?? 'The teammate who chose it'} chose this through their own ${name} connection, which needs a fresh sign-in. They can reconnect it, or anyone with access can choose it again through their own connection.`
  return new GoogleSeoError('RECONNECT_NEEDED', product, message, {
    reconnectBy: who,
    detail,
  })
}
