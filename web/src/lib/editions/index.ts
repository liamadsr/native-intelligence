/**
 * Persona editions — the public surface of the module.
 *
 * Consumers import from `@/lib/editions`, never from the individual files, so
 * the internal split (manifest / resolve / tool-ceiling) stays an
 * implementation detail. See manifest.ts for the design invariants.
 */

export {
  EDITIONS,
  EDITION_IDS,
  EDITION_LIST,
  DEFAULT_EDITION_ID,
  BUSINESS_EDITION_ID,
  ALWAYS_ALLOWED_VIEWS,
  normalizeEditionId,
  isEditionId,
  getEdition,
  isViewAllowed,
  allowedViews,
  isAutoCreateAllowed,
  editionDefaultAgentSlug,
  APP_TERMS,
  APP_WORDS,
  // ── Features: the unit editions are composed from and users toggle ──
  FEATURES,
  FEATURE_KEYS,
  FEATURE_LIST,
  ADMIN_FEATURE_LIST,
  STANDARD_FEATURE_KEYS,
  NON_DEFAULT_FEATURE_KEYS,
  NON_DEFAULT_FEATURE_TOOL_CATEGORIES,
  HIDDEN_FEATURE_KEYS,
  ALL_FEATURE_GATED_RECIPE_IDS,
  TOGGLEABLE_FEATURE_KEYS,
  ADMIN_TOGGLEABLE_FEATURE_KEYS,
  CORE_FEATURE,
  isFeatureKey,
  isFeatureEnabled,
  featureGatedRecipeExclusions,
  normalizeFeatureOverrides,
  resolveFeatureClosure,
  effectiveFeatureKeys,
  composeSurface,
  composeEffectiveSurface,
  withEffectiveSurface,
  type EditionId,
  type EditionView,
  type EditionEntityType,
  type EditionDefinition,
  type EditionDefaultAgents,
  type EditionAgentMode,
  type EditionTerm,
  type EditionWords,
  type TermWords,
  type PageWords,
  type StarterWords,
  type FeatureKey,
  type FeatureDefinition,
  type FeatureState,
  type FeatureOverrides,
  type ComposedSurface,
  type EffectiveSurface,
} from './manifest'

export {
  resolveWorkspaceEdition,
  resolveWorkspaceEditionFromSettings,
  resolveWorkspaceEditionId,
  stampWorkspaceEdition,
  setWorkspaceEdition,
  adoptBusinessEdition,
  EDITION_SOURCE_KEY,
  type BusinessAdoption,
  type EditionSource,
  type ResolvedEdition,
  type StampResult,
} from './resolve'

export {
  setWorkspaceFeatureState,
  pruneNoOpOverrides,
  isOnByDefault,
  type FeatureWriteState,
  type FeatureWriteResult,
  type SetWorkspaceFeatureStateOptions,
} from './features'

export {
  EDITION_WORDS_SECTION_KEY,
  editionWords,
  termWords,
  countTerm,
  pageWords,
  cleanBookingKind,
  pluralWord,
  renderEditionWordsSection,
  type BusinessWords,
} from './words'

export {
  computeEditionToolCeiling,
  offFeatureDeniedToolNames,
  intersectCeilings,
} from './tool-ceiling'
