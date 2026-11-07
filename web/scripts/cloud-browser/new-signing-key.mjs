// A fresh Ed25519 key for the cloud browser's sandbox tokens (docs/plans/cloud-browser.md,
// C3/C4: the live view and the Mac exit). Prints the value for CLOUD_BROWSER_SIGNING_KEY;
// set it per environment (Production and Preview), never commit it. The sandbox only
// ever gets the public half, derived from it at each start.
//   node scripts/cloud-browser/new-signing-key.mjs
import { generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('ed25519')
console.log(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
