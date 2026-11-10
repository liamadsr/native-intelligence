# Windows code signing (Azure Artifact Signing)

Native Intelligence's Windows release builds are Authenticode-signed by **Azure Artifact Signing** (formerly Trusted
Signing), about $9.99/month for 5,000 signatures. The signing runs on the Windows workflow's runner
(`.github/workflows/windows.yml`, "Build config" + "Build"):

- Tauri runs SignTool with Microsoft's Artifact Signing dlib on everything it bundles: `Dial8.exe`, the
  installer and its uninstaller.
- The packages are pinned NuGet versions, checked by SHA-256.
- The runner signs in to Azure with GitHub's OIDC token (`azure/login`), so **no secret is stored
  anywhere**.
- Only a `workflow_dispatch` build of `main` (what `release.sh` starts) signs. A PR's test installer
  stays unsigned.

Until the repository variables below exist, release builds are unsigned, as before. Windows then shows
"Windows protected your PC / Unknown publisher" (More info → Run anyway), and Smart App Control or a
managed PC can refuse the app outright. Even signed, SmartScreen builds reputation over a few weeks.

## One-time setup (Liam, in Azure and GitHub)

1. **Eligibility.** Public-trust signing is for organizations in the US, Canada, the EU or the UK. Reports
   say new sign-ups need about 3 years of verifiable business history. If Native Intelligence's entity doesn't qualify,
   an OV certificate from a CA (~$150–300/yr, cloud HSM) works with the same `signCommand` and a different
   tool.
2. **Azure subscription + resource group**, e.g. `dial8-signing`, in a region near you (East US, West
   Europe, …).
3. **Artifact Signing account** (portal → "Artifact Signing Accounts" → Create), in that resource group.
   Note its **name** and **Account URI**, the endpoint. The endpoint must match the region, e.g.
   `https://eus.codesigning.azure.net/`.
4. **Identity validation** (account → Identity validation → New → Public → Organization). Microsoft checks
   the business's documents; it takes days to weeks.
5. **Certificate profile** (account → Certificate profiles → Create → Public Trust), on the validated
   identity, e.g. named `dial8`.
6. **An identity for GitHub** (Entra ID → App registrations → New), e.g. `dial8-windows-signing`:
   - Certificates & secrets → Federated credentials → Add → "GitHub Actions deploying Azure resources":
     your GitHub organization and the desktop app's repository, entity **Branch**, branch `main`.
   - Note its **Application (client) ID** and **Directory (tenant) ID**.
7. **Role:** on the Artifact Signing account (or the certificate profile) → Access control (IAM) → Add
   role assignment → **Artifact Signing Certificate Profile Signer** → the app registration.
8. **GitHub repository variables** (Settings → Secrets and variables → Actions → **Variables**; they're
   IDs, not secrets):

   | Variable | Value |
   |---|---|
   | `AZURE_CLIENT_ID` | the app registration's client ID |
   | `AZURE_TENANT_ID` | the tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | the subscription holding the account |
   | `ARTIFACT_SIGNING_ENDPOINT` | the account's endpoint (Account URI) |
   | `ARTIFACT_SIGNING_ACCOUNT` | the account's name |
   | `ARTIFACT_SIGNING_PROFILE` | the certificate profile's name |

The next `./release.sh` then ships a signed installer. The workflow's "The installer is signed" step fails
the build if the signature isn't `Valid`, so an unsigned installer is never published once signing is set
up.

## Where it can go wrong

- **403 / SignerSign() failed:** the endpoint's region doesn't match the account's, or the role isn't
  assigned to the app registration.
- **AADSTS70021 (no matching federated identity):** the build didn't run on `main`, e.g. `release.sh` run
  from another branch. The federated credential trusts `main` only.
- Certificates live three days; every signature is timestamped (`timestamp.acs.microsoft.com`), so signed
  builds stay valid after that.
