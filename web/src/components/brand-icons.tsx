/**
 * Official brand icons for integrations.
 *
 * Single source of truth for the company logos shown on the landing-page
 * integrations demo and in account settings → integrations. Every mark here is
 * the real, official logo — not an approximation.
 *
 * Sources:
 *  - GitHub, HubSpot, Asana, Jira, Linear, Zapier: `@icons-pack/react-simple-icons` (the
 *    official Simple Icons set). Rendered with `color="default"` so each keeps
 *    its own brand color, except GitHub whose mark is near-black and is tinted
 *    per-theme.
 *  - Gmail and Google Calendar: the full multicolor logos, inlined from Google's
 *    brand assets. Simple Icons only ships flat single-color versions of these
 *    (a red "M" and a blue calendar outline), which read as generic.
 *  - Slack: official multicolor mark (Simple Icons removed Slack over trademark
 *    policy, so the path is inlined here from Slack's published brand asset).
 *  - Outlook Mail / Calendar: Microsoft's real gradient Outlook logo. It has 13
 *    gradients, so instead of inlining it (twice — the gradient IDs would
 *    collide) it's served from `public/brand-icons/outlook.svg` via <img>.
 *    Microsoft ships ONE Outlook logo for both mail and calendar, so both rows
 *    intentionally use the same mark.
 *  - Affinity (CRM, affinity.co) and Attio (attio.com): inlined from each
 *    company's own site assets. NOTE: "Affinity" here is the relationship CRM,
 *    not Serif's "Affinity" design suite — different company, different logo.
 *  - Kimi (Moonshot AI) and DeepSeek: monochrome marks inlined from Simple
 *    Icons v16 (CC0). The `@icons-pack/react-simple-icons` release we're on
 *    still ships none of SiKimi/SiMoonshotai/SiDeepseek, so they're inlined
 *    here and tinted with `currentColor` like the Attio mark.
 *
 * Every icon accepts an optional `className` (defaults to `h-5 w-5`) so callers
 * can size them consistently in their icon tiles.
 */

import {
  SiAsana,
  SiGithub,
  SiHubspot,
  SiJira,
  SiLinear,
  SiZapier,
} from '@icons-pack/react-simple-icons'

interface BrandIconProps {
  className?: string
}

const DEFAULT_SIZE = 'h-5 w-5'

// ── Library-backed (official Simple Icons) ──

export function GitHubIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // GitHub's brand mark is #181717 (near-black); flip to white on dark surfaces.
  return <SiGithub className={`${className} text-[#181717] dark:text-white`} />
}

export function GmailIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Full multicolor Gmail logo (red/blue/green/yellow envelope).
  return (
    <svg className={className} viewBox="0 49.4 512 399.42" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285f4" d="M34.91 448.818h81.454V251L0 163.727V413.91c0 19.287 15.622 34.91 34.91 34.91z" />
      <path fill="#34a853" d="M395.636 448.818h81.455c19.287 0 34.909-15.622 34.909-34.909V163.727L395.636 251z" />
      <path fill="#fbbc04" d="M395.636 99.727V251L512 163.727v-46.545c0-43.142-49.25-67.782-83.782-41.891z" />
      <path fill="#ea4335" d="M116.364 251V99.727L256 204.455 395.636 99.727V251L256 355.727z" />
      <path fill="#c5221f" d="M0 117.182v46.545L116.364 251V99.727L83.782 75.291C49.25 49.4 0 74.04 0 117.18z" />
    </svg>
  )
}

export function GoogleCalendarIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Full multicolor Google Calendar "31" mark. Simple Icons only ships a flat
  // single-blue outline, so this is inlined from Google's brand asset.
  return (
    <svg className={className} viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M390.736 121.264H121.264V390.736H390.736V121.264Z" fill="#fff" />
      <path d="M390.736 512L512 390.736L451.368 380.392L390.736 390.736L379.67 446.196L390.736 512Z" fill="#EA4335" />
      <path d="M0 390.736V471.578C0 493.912 18.088 512 40.42 512H121.264L133.714 451.368L121.264 390.736L55.198 380.392L0 390.736Z" fill="#188038" />
      <path d="M512 121.264V40.42C512 18.088 493.912 0 471.58 0H390.736C383.36 30.072 379.671 52.2027 379.67 66.392C379.67 80.58 383.359 98.8707 390.736 121.264C417.556 128.944 437.767 132.784 451.368 132.784C464.969 132.784 485.18 128.945 512 121.264Z" fill="#1967D2" />
      <path d="M512 121.264H390.736V390.736H512V121.264Z" fill="#FBBC04" />
      <path d="M390.736 390.736H121.264V512H390.736V390.736Z" fill="#34A853" />
      <path d="M390.736 0H40.422C18.088 0 0 18.088 0 40.42V390.736H121.264V121.264H390.736V0Z" fill="#4285F4" />
      <path d="M176.54 330.308C166.468 323.504 159.494 313.568 155.688 300.428L179.066 290.796C181.186 298.88 184.891 305.145 190.182 309.592C195.436 314.038 201.836 316.228 209.314 316.228C216.959 316.228 223.527 313.903 229.018 309.254C234.51 304.606 237.272 298.678 237.272 291.504C237.272 284.16 234.375 278.164 228.582 273.516C222.788 268.868 215.512 266.544 206.822 266.544H193.314V243.404H205.44C212.917 243.404 219.216 241.382 224.336 237.338C229.456 233.298 232.016 227.772 232.016 220.732C232.016 214.468 229.726 209.482 225.146 205.744C220.566 202.004 214.77 200.118 207.73 200.118C200.858 200.118 195.402 201.938 191.36 205.608C187.319 209.289 184.282 213.937 182.534 219.116L159.394 209.482C162.458 200.792 168.084 193.112 176.336 186.476C184.588 179.84 195.132 176.506 207.932 176.506C217.398 176.506 225.92 178.326 233.466 181.996C241.01 185.668 246.938 190.754 251.216 197.222C255.496 203.722 257.616 210.998 257.616 219.082C257.616 227.334 255.63 234.308 251.656 240.034C247.682 245.76 242.796 250.138 237.002 253.204V254.584C244.483 257.669 250.982 262.735 255.798 269.238C260.682 275.806 263.142 283.654 263.142 292.818C263.142 301.978 260.816 310.164 256.168 317.338C251.52 324.514 245.088 330.172 236.934 334.282C228.75 338.392 219.554 340.482 209.348 340.482C197.524 340.514 186.612 337.112 176.54 330.308ZM320.132 214.298L294.466 232.858L281.632 213.39L327.678 180.176H345.328V336.842H320.132V214.298Z" fill="#4285F4" />
    </svg>
  )
}

export function AsanaIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return <SiAsana className={className} color="default" />
}

export function JiraIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Atlassian's Jira mark, brand blue #0052CC. `SiJira` is the platform mark;
  // `SiJirasoftware` (also in the package) is the product-specific variant we
  // deliberately don't use — the integration targets Jira's platform issue APIs,
  // not Jira Software's boards/sprints.
  return <SiJira className={className} color="default" />
}

export function HubSpotIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return <SiHubspot className={className} color="default" />
}

export function LinearIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Linear's own mark in its brand purple (#5E6AD2), which `color="default"`
  // resolves to from the package's own metadata — the same idiom as Asana, Jira
  // and HubSpot above. NOT inlined: unlike Kimi/DeepSeek/Attio, the release we
  // are on DOES ship `SiLinear`, so inlining it would be a copy that silently
  // stops tracking the upstream mark.
  return <SiLinear className={className} color="default" />
}

export function ZapierIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return <SiZapier className={className} color="default" />
}

// ── Inlined official marks (not in the Simple Icons package) ──

export function SlackIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 2447.6 2452.5"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g clipRule="evenodd" fillRule="evenodd">
        <path
          d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z"
          fill="#36c5f0"
        />
        <path
          d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z"
          fill="#2eb67d"
        />
        <path
          d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z"
          fill="#ecb22e"
        />
        <path
          d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0"
          fill="#e01e5a"
        />
      </g>
    </svg>
  )
}

// Microsoft's real Outlook logo is a 13-gradient SVG served from public/ (see
// the file header for why it's an <img> and not inlined). Both Outlook Mail and
// Outlook Calendar use it — Microsoft ships one Outlook mark for both.
export function OutlookIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return <img src="/brand-icons/outlook.svg" alt="" aria-hidden="true" className={className} />
}

export function OutlookCalendarIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  return <img src="/brand-icons/outlook.svg" alt="" aria-hidden="true" className={className} />
}

export function AffinityIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Symbol-only mark from affinity.co's own brand asset (wordmark stripped).
  return (
    <svg className={className} viewBox="0 0 42 42" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M36.2425 20.7692C36.2418 21.1012 36.2 21.4318 36.118 21.7535L38.1678 23.8166C42.1219 27.8365 42.0939 34.2895 38.1051 38.2749C34.1162 42.2603 27.6577 42.2883 23.6345 38.3376L21.6018 36.3067C20.9344 36.4836 20.2323 36.4836 19.5649 36.3067L17.5451 38.3269C13.5318 42.3373 7.02457 42.3378 3.01071 38.3279C-1.00315 34.3181 -1.00363 27.8163 3.00964 23.8059L5.28054 21.5348C5.17894 21.0251 5.17894 20.5004 5.28054 19.9907L3.01178 17.7217C0.415654 15.1274 -0.598046 11.3463 0.352536 7.80279C1.30312 4.25924 4.07356 1.49156 7.62028 0.542315C11.167 -0.406933 14.9511 0.606461 17.5473 3.20076L19.3266 4.97862C20.1441 4.71219 21.0259 4.71745 21.8401 4.99363L23.6366 3.19862C27.6599 -0.752113 34.1184 -0.724137 38.1072 3.2613C42.0961 7.24674 42.1241 13.6997 38.17 17.7196L36.1137 19.7741C36.1991 20.0989 36.2424 20.4333 36.2425 20.7692ZM26.4135 5.98842L24.4818 7.91854C24.5467 8.2057 24.5798 8.49913 24.5805 8.79353C24.5808 9.21316 24.5141 9.63014 24.383 10.0288L31.2472 16.8807C31.5683 16.7978 31.8987 16.756 32.2303 16.7564C32.6258 16.7559 33.0193 16.8137 33.3979 16.9279L35.3791 14.9463C37.7845 12.461 37.7514 8.50761 35.3046 6.06287C32.8577 3.61814 28.901 3.58501 26.4135 5.98842ZM24.4521 31.4274L31.2283 24.6548C31.9434 24.8416 32.6966 24.8245 33.4026 24.6055L35.3859 26.5871C37.7913 29.0725 37.7582 33.0258 35.3113 35.4706C32.8645 37.9153 28.9078 37.9484 26.4203 35.545L24.4199 33.5441C24.5261 33.1789 24.5803 32.8006 24.5808 32.4204C24.5809 32.0852 24.5376 31.7515 24.4521 31.4274ZM21.7277 28.5837L28.3816 21.9355L28.3837 21.9398C28.1505 21.1766 28.1505 20.3612 28.3837 19.598L21.483 12.7031C20.893 12.845 20.2781 12.8487 19.6864 12.7138L12.9961 19.3942C13.3195 20.28 13.3195 21.2514 12.9961 22.1371L19.4353 28.5709C20.1844 28.3522 20.9811 28.3566 21.7277 28.5837ZM16.7583 10.0723L16.7551 10.0755C16.5154 9.3679 16.4808 8.60699 16.6553 7.88053L14.76 5.98686C12.2725 3.58345 8.31578 3.61658 5.86896 6.06132C3.42214 8.50605 3.38898 12.4594 5.79444 14.9448L7.85714 17.0036C8.54324 16.7504 9.2859 16.691 10.0036 16.832L16.7551 10.0755L16.7562 10.0787L16.7583 10.0723ZM10.0035 24.7069C9.2862 24.8478 8.54394 24.7899 7.85714 24.5396L5.79444 26.5877C3.38898 29.0731 3.42214 33.0264 5.86896 35.4711C8.31578 37.9159 12.2725 37.949 14.76 35.5456L16.7175 33.5876C16.6031 33.2093 16.5452 32.8162 16.5458 32.4209C16.5455 32.0704 16.5917 31.7214 16.6832 31.383L10.0035 24.7069Z"
        fill="#2665F1"
      />
    </svg>
  )
}

export function KimiIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Monochrome Kimi (Moonshot AI) mark, inlined from Simple Icons v16 (CC0).
  // The package doesn't ship SiKimi/SiMoonshotai yet. `fill="currentColor"`
  // so it inherits text color like SiClaude does in its icon tiles.
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <title>Kimi</title>
      <path d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441" />
    </svg>
  )
}

export function DeepSeekIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Monochrome DeepSeek mark, inlined from Simple Icons v16 (CC0). The package
  // doesn't ship SiDeepseek yet. `fill="currentColor"` so it inherits text
  // color like SiClaude does in its icon tiles.
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <title>DeepSeek</title>
      <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
    </svg>
  )
}

export function AttioIcon({ className = DEFAULT_SIZE }: BrandIconProps) {
  // Official "A" mark from attio.com's own brand asset. It's a stroked (outline)
  // monochrome mark — stroke uses currentColor so it reads on light and dark
  // tiles alike; Attio's own asset strokes it in #232529.
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M16.7802 11.5317L15.4723 9.43851C15.4723 9.43851 15.4674 9.42975 15.4645 9.42586L15.3613 9.2614C15.1667 8.94902 14.83 8.76218 14.4622 8.76121L12.3553 8.75439L12.2084 8.98989L9.69085 13.0187L9.55169 13.2415L10.6066 14.927C10.8012 15.2404 11.1379 15.4272 11.5087 15.4272H14.4612C14.8251 15.4272 15.1696 15.2355 15.3623 14.928L15.4664 14.7616C15.4664 14.7616 15.4703 14.7567 15.4713 14.7548L16.7812 12.6586C16.9962 12.3161 16.9962 11.8733 16.7812 11.5317H16.7802ZM16.3812 12.4085L15.0714 14.5047C15.0655 14.5144 15.0587 14.5222 15.0529 14.53C15.0071 14.5816 14.9478 14.5884 14.9215 14.5884C14.8913 14.5884 14.8174 14.5796 14.7697 14.5037L13.4598 12.4076C13.4452 12.3842 13.4326 12.3599 13.4209 12.3336C13.4092 12.3083 13.4005 12.283 13.3927 12.2567C13.3635 12.1516 13.3635 12.0387 13.3927 11.9336C13.4073 11.8821 13.4297 11.8305 13.4589 11.7838L14.7668 9.68958C14.7668 9.68958 14.7687 9.68666 14.7697 9.68472C14.8008 9.63801 14.8397 9.6166 14.8738 9.60979C14.8874 9.60589 14.8991 9.60492 14.9088 9.60297C14.9137 9.60297 14.9186 9.60297 14.9234 9.60297C14.9536 9.60297 15.0285 9.61271 15.0752 9.68861L16.3831 11.7818C16.5028 11.9726 16.5028 12.2178 16.3831 12.4085H16.3812Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M12.9099 6.46677C13.124 6.12325 13.124 5.68145 12.9099 5.33988L11.602 3.24665L11.493 3.07051C11.2974 2.75813 10.9607 2.57129 10.5909 2.57129H7.63838C7.26956 2.57129 6.93285 2.75813 6.73628 3.07148L1.4492 11.5329C1.34313 11.7023 1.28571 11.8979 1.28571 12.0964C1.28571 12.2949 1.34216 12.4905 1.44823 12.6589L2.8661 14.9292C3.0617 15.2426 3.3984 15.4284 3.76722 15.4284H6.71974C7.0905 15.4284 7.42721 15.2416 7.62184 14.9282L7.72986 14.757C7.72986 14.757 7.72986 14.757 7.72986 14.755C7.72986 14.755 7.7318 14.7521 7.7318 14.7511L8.78572 13.0656L11.9095 8.06662L12.9079 6.46775L12.9099 6.46677ZM12.6014 5.90332C12.6014 6.01134 12.5712 6.12034 12.5099 6.21668L7.33087 14.5059C7.28416 14.5808 7.20923 14.5896 7.17906 14.5896C7.14889 14.5896 7.07493 14.5808 7.02725 14.5059L5.71837 12.4088C5.59965 12.219 5.59965 11.9748 5.71837 11.783L10.8974 3.49577C10.9441 3.41987 11.0191 3.41111 11.0492 3.41111C11.0794 3.41111 11.1543 3.41987 11.202 3.49675L12.5099 5.58997C12.5712 5.68631 12.6014 5.79531 12.6014 5.90332V5.90332Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}
