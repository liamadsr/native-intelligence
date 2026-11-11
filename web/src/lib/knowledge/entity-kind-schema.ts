/**
 * A kind argument (a tool's `entity_type`, a route body's `source_type`) as a
 * zod schema. It is `z.enum(values)`, except that a retired name is read as
 * the kind it names now (RETIRED_ENTITY_TYPE_NAMES in ./entity-registry: `email`
 * is `email_thread` since migration 503), so a model quoting an earlier turn or
 * an older client keeps working. The schema the model is shown lists the
 * current names only: the preprocess step renders to nothing in JSON Schema.
 *
 * Kept out of the registry because the registry is plain data with no imports.
 */
import { z } from 'zod'
import { canonicalEntityTypeInput } from './entity-registry'

export function entityKindEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(canonicalEntityTypeInput, z.enum(values))
}
