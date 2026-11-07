#!/usr/bin/env node
/**
 * Regenerate src/lib/vocabulary/lexicon-words.ts (the sound-match ordinary-word
 * lexicon; sources and licenses in src/lib/vocabulary/LEXICON-NOTICE.md) and
 * src/lib/vocabulary/lexicon-names.ts (its first names that are nothing else:
 * no common word, day, place or tech word, so a "sounds like" of one, "Toma"
 * for Thomas, may be matched exactly where an everyday word never is).
 *
 *   npm pack wordlist-english@1.2.1 && tar xzf wordlist-english-1.2.1.tgz
 *   curl -LO https://raw.githubusercontent.com/hadley/data-baby-names/master/baby-names.csv
 *   node scripts/vocabulary/build-lexicon.mjs ./package ./baby-names.csv
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [scowlDir, namesCsv] = process.argv.slice(2)
if (!scowlDir || !namesCsv) {
  console.error('usage: build-lexicon.mjs <wordlist-english package dir> <baby-names.csv>')
  process.exit(1)
}

const words = new Set()
for (const variety of ['english', 'american']) {
  for (const level of [10, 20, 35, 40, 50]) {
    for (const w of JSON.parse(readFileSync(join(scowlDir, `${variety}-words-${level}.json`), 'utf8'))) {
      words.add(String(w).toLowerCase())
    }
  }
}
const scowl = words.size

const scowlWords = new Set(words)
const names = new Set()
const lines = readFileSync(namesCsv, 'utf8').split('\n').slice(1)
for (const line of lines) {
  const name = line.split(',')[1]?.replace(/"/g, '').trim().toLowerCase()
  if (name) names.add(name)
}
for (const n of names) words.add(n)
// What else is ordinary, besides names: the common words above and the lists below.
const notNames = new Set(scowlWords)

// SCOWL leaves contractions out; transcripts are full of them.
const EXTRA = `i'm i'll i've i'd you're you'll you've you'd we're we'll we've we'd they're they'll they've they'd
he's he'll he'd she's she'll she'd it's it'll it'd that's that'll that'd there's there'll there'd here's what's
what'll what'd who's who'll who'd where's when's why's how's let's don't doesn't didn't can't couldn't won't
wouldn't shouldn't isn't aren't wasn't weren't haven't hasn't hadn't mustn't mightn't needn't ain't y'all
o'clock gonna wanna gotta kinda sorta dunno lemme gimme yeah yep nope okay ok uh um hmm mhm`
for (const w of EXTRA.split(/\s+/)) if (w) words.add(w), notNames.add(w)

// SCOWL's lists are lowercase common words: no days, months, places, languages
// or nationalities, which every meeting says. Ordinary for sound-match (never
// replaced) and for learning (never "unusual").
const PROPER = `monday tuesday wednesday thursday friday saturday sunday
mon tue tues wed thu thur thurs fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec
january february march april may june july august september october november december
christmas easter thanksgiving hanukkah ramadan diwali halloween
afghanistan albania algeria andorra angola argentina armenia australia austria azerbaijan bahamas bahrain bangladesh
barbados belarus belgium belize benin bhutan bolivia bosnia botswana brazil brunei bulgaria burundi cambodia cameroon
canada chad chile china colombia comoros congo croatia cuba cyprus czechia czech denmark djibouti dominica ecuador egypt
eritrea estonia eswatini ethiopia fiji finland france gabon gambia georgia germany ghana greece grenada guatemala guinea
guyana haiti honduras hungary iceland india indonesia iran iraq ireland israel italy jamaica japan jordan kazakhstan kenya
kiribati korea kosovo kuwait kyrgyzstan laos latvia lebanon lesotho liberia libya liechtenstein lithuania luxembourg
madagascar malawi malaysia maldives mali malta mauritania mauritius mexico micronesia moldova monaco mongolia montenegro
morocco mozambique myanmar namibia nauru nepal netherlands nicaragua niger nigeria norway oman pakistan palau palestine
panama paraguay peru philippines poland portugal qatar romania russia rwanda samoa senegal serbia seychelles singapore
slovakia slovenia somalia spain sudan suriname sweden switzerland syria taiwan tajikistan tanzania thailand togo tonga
trinidad tobago tunisia turkey turkmenistan tuvalu uganda ukraine emirates uruguay uzbekistan vanuatu vatican venezuela
vietnam yemen zambia zimbabwe britain england scotland wales usa uk eu
alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii idaho illinois indiana iowa
kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada
hampshire jersey mexico york carolina dakota ohio oklahoma oregon pennsylvania rhode tennessee texas utah vermont
virginia washington wisconsin wyoming
london paris berlin madrid rome lisbon dublin amsterdam brussels vienna zurich geneva prague warsaw budapest stockholm
oslo copenhagen helsinki athens istanbul moscow kyiv cairo lagos nairobi johannesburg dubai mumbai delhi bangalore
bengaluru chennai hyderabad karachi lahore dhaka bangkok jakarta manila hanoi seoul tokyo osaka kyoto beijing shanghai
shenzhen sydney melbourne brisbane perth auckland toronto vancouver montreal ottawa calgary seattle portland boston
chicago houston dallas austin denver phoenix atlanta miami orlando detroit philadelphia pittsburgh baltimore brooklyn
manhattan queens bronx nyc sf la vegas nashville charlotte raleigh minneapolis cleveland cincinnati columbus sacramento
oakland berkeley palo alto cupertino sunnyvale mountain jose diego francisco angeles barcelona milan munich hamburg
frankfurt edinburgh manchester liverpool cambridge oxford bristol leeds glasgow cardiff belfast tel aviv jerusalem
english spanish french german italian portuguese dutch russian chinese mandarin cantonese japanese korean arabic hindi
urdu bengali punjabi tamil telugu persian farsi turkish greek polish ukrainian swedish norwegian danish finnish hebrew
american british canadian australian mexican brazilian indian pakistani nigerian kenyan egyptian israeli irish scottish
european african asian latino latina hispanic`
for (const w of PROPER.split(/\s+/)) if (w) words.add(w), notNames.add(w)

// Everyday modern and tech words SCOWL's common levels predate, and household
// brand names every engine already spells right: ordinary, never harvested.
const MODERN = `app apps offline online signup login logout wifi upload uploads download downloads chatbot chatbots
api ui ux saas crm erp kpi okr roadmap onboarding offboarding standup livestream webinar ebook podcast bluetooth
analytics scalability url html css javascript typescript sql json csv pdf jpeg png gif mp3 mp4 usb hdmi vpn
ai ml llm gpu cpu ios macos linux emoji hashtag selfie smartphone laptop inbox username password screenshot
youtube facebook instagram tiktok linkedin twitter whatsapp iphone ipad macbook netflix uber airbnb amazon
microsoft google apple chatgpt openai github gitlab zoom slack gmail outlook excel powerpoint`
for (const w of MODERN.split(/\s+/)) if (w) words.add(w), notNames.add(w)

const sorted = [...words].filter((w) => w && !w.includes('\n') && !w.includes('`') && !w.includes('\\') && !w.includes('$')).sort()
const out = join(dirname(fileURLToPath(import.meta.url)), '../../src/lib/vocabulary/lexicon-words.ts')
writeFileSync(
  out,
  `// GENERATED by scripts/vocabulary/build-lexicon.mjs. Do not edit by hand.\n` +
    `// Sources and licenses: ./LEXICON-NOTICE.md (SCOWL, copyright 2000-2016 Kevin Atkinson; SSA baby names, public domain).\n` +
    `// ${sorted.length} words.\n` +
    `export const LEXICON_WORDS = \`${sorted.join('\n')}\`\n`,
)
console.log(`scowl ${scowl}, names ${names.size}, total ${sorted.length} -> ${out}`)

const onlyNames = sorted.filter((w) => names.has(w) && !notNames.has(w))
const namesOut = join(dirname(fileURLToPath(import.meta.url)), '../../src/lib/vocabulary/lexicon-names.ts')
writeFileSync(
  namesOut,
  `// GENERATED by scripts/vocabulary/build-lexicon.mjs. Do not edit by hand.\n` +
    `// The lexicon's first names that are nothing else (SSA baby names, public domain; see ./LEXICON-NOTICE.md).\n` +
    `// ${onlyNames.length} names.\n` +
    `export const NAME_ONLY_WORDS = \`${onlyNames.join('\n')}\`\n`,
)
console.log(`names that are nothing else ${onlyNames.length} -> ${namesOut}`)
