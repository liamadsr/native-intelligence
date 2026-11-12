/**
 * Finding a place (a city, county or region) in a country's list of search
 * locations from what a person typed ("Portland OR", "Catonsville"). The
 * provider matches a location name verbatim, so the canonical row has to be
 * found, not a substring: a plain `includes` filter buries
 * "Portland,Oregon,United States" under every "…,Portland,…" row that sorts
 * earlier. Pure; the list itself comes from the provider's free locations
 * endpoint (fetchSerpLocationsForCountry).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */

interface RankablePlace {
  locationName: string
  locationType: string
}

/** Region abbreviations people write after a city, per country, so "Rio de Janeiro" in Brazil never reads "de" as Delaware. */
const REGION_ABBREVIATIONS: Record<string, Record<string, string>> = {
  us: {
    al: 'Alabama',
    ak: 'Alaska',
    az: 'Arizona',
    ar: 'Arkansas',
    ca: 'California',
    co: 'Colorado',
    ct: 'Connecticut',
    de: 'Delaware',
    fl: 'Florida',
    ga: 'Georgia',
    hi: 'Hawaii',
    id: 'Idaho',
    il: 'Illinois',
    in: 'Indiana',
    ia: 'Iowa',
    ks: 'Kansas',
    ky: 'Kentucky',
    la: 'Louisiana',
    me: 'Maine',
    md: 'Maryland',
    ma: 'Massachusetts',
    mi: 'Michigan',
    mn: 'Minnesota',
    ms: 'Mississippi',
    mo: 'Missouri',
    mt: 'Montana',
    ne: 'Nebraska',
    nv: 'Nevada',
    nh: 'New Hampshire',
    nj: 'New Jersey',
    nm: 'New Mexico',
    ny: 'New York',
    nc: 'North Carolina',
    nd: 'North Dakota',
    oh: 'Ohio',
    ok: 'Oklahoma',
    or: 'Oregon',
    pa: 'Pennsylvania',
    ri: 'Rhode Island',
    sc: 'South Carolina',
    sd: 'South Dakota',
    tn: 'Tennessee',
    tx: 'Texas',
    ut: 'Utah',
    vt: 'Vermont',
    va: 'Virginia',
    wa: 'Washington',
    wv: 'West Virginia',
    wi: 'Wisconsin',
    wy: 'Wyoming',
    dc: 'District of Columbia',
  },
  ca: {
    ab: 'Alberta',
    bc: 'British Columbia',
    mb: 'Manitoba',
    nb: 'New Brunswick',
    nl: 'Newfoundland and Labrador',
    ns: 'Nova Scotia',
    nt: 'Northwest Territories',
    nu: 'Nunavut',
    on: 'Ontario',
    pe: 'Prince Edward Island',
    qc: 'Quebec',
    sk: 'Saskatchewan',
    yt: 'Yukon',
  },
  au: {
    nsw: 'New South Wales',
    vic: 'Victoria',
    qld: 'Queensland',
    sa: 'South Australia',
    tas: 'Tasmania',
    act: 'Australian Capital Territory',
  },
}

/** What a person most likely means by a place name, most specific first. */
const LOCATION_TYPE_RANK: Record<string, number> = {
  City: 0,
  Municipality: 1,
  'City Region': 2,
  Borough: 2,
  County: 3,
  State: 4,
  Province: 4,
  Region: 4,
  Country: 5,
  'DMA Region': 6,
  Neighborhood: 7,
  District: 7,
}

/** Lowercase, accents stripped, whitespace collapsed. */
export function foldPlaceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Portland OR" -> ["portland", "oregon"]. Never the first word: "La Crosse" and "De Pere" are places, not states. */
function tokenize(query: string, countryCode: string | undefined): string[] {
  const tokens = foldPlaceText(query)
    .split(/[\s,]+/)
    .filter(Boolean)
  const abbreviations = REGION_ABBREVIATIONS[countryCode?.toLowerCase() ?? '']
  if (!abbreviations) return tokens
  return tokens.map((token, index) => {
    const region = index > 0 ? abbreviations[token] : undefined
    return region ? foldPlaceText(region) : token
  })
}

/** The places matching a query, best first, at most `limit`. */
export function rankPlaces<T extends RankablePlace>(
  query: string,
  places: readonly T[],
  countryCode?: string,
  limit = 50,
): T[] {
  const tokens = tokenize(query, countryCode)
  if (tokens.length === 0) return []
  const phrase = tokens.join(' ')
  const head = tokens[0]
  const scored: Array<{ place: T; score: number; folded: string }> = []
  for (const place of places) {
    const folded = foldPlaceText(place.locationName)
    // Multi-word expansions ("new york") never survive a split, so each token is matched against the whole name.
    if (!tokens.every((token) => folded.includes(token))) continue
    const comma = folded.indexOf(',')
    const first = comma < 0 ? folded : folded.slice(0, comma).trim()
    const score =
      first === phrase ? 0 : first === head ? 1 : first.startsWith(head) ? 2 : 3
    scored.push({ place, score, folded })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      (LOCATION_TYPE_RANK[a.place.locationType] ?? 9) -
        (LOCATION_TYPE_RANK[b.place.locationType] ?? 9) ||
      (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0),
  )
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.place)
}
