#!/usr/bin/env python3
"""Checks the app's settings on the server (deploy/app/.env) before the switch of
the real names (../README.md step 21, Gate 1), without showing a value.

check-settings.sh sends this program to the server and runs it there as root; so
does pull-settings.sh, with --names-only, for its closing report. It prints, for
each setting, whether it is set and, where that can be checked from here, whether
it is the right value: never the value, at most its length.

What "the right value" means depends on the setting, so they are in four groups:

  must match   what it signs or encrypts is already stored, or a provider holds
               the other copy: only the value the earlier host has works. Where
               production's own data can tell, it is checked against that data
               (a stored ciphertext must open, a stored hash must be reproduced,
               a pinned public key must match).
  needed       any working value does; checked against its provider where a
               call that changes nothing can tell (reads, and for Slack the
               short-lived tokens the app itself would ask for).
  may be empty the app runs without it, and what is then off is said.
  the switch   NI_LIVE, which step 21 sets and nothing else may.

  check_settings.py <env file> [--names-only] [--fill <envfile.py>]
                    [--pinned <base64 SPKI> ...] [--embedding-model <name>]

--fill writes the one value this program can bring from where it is held:
GPT_LIVE_TRUNK_SECRET, read from the Twilio trunk's origination address with the
Twilio settings already in the file, when it is empty and exactly one is found.

Needs python3 and its cryptography package (Ubuntu's python3-cryptography), the
database container (supabase-db, or CHECK_DB_CONTAINER) and outbound HTTPS.
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# --- the groups ---------------------------------------------------------------------

MUST_MATCH = {
    "CREDENTIAL_ENCRYPTION_KEY": "encrypts every connected account's tokens in the database",
    "RUN_SKILL_INTERNAL_SECRET": "keys the stored link, invite and code hashes, and the reply codes already texted",
    "CLOUD_BROWSER_SIGNING_KEY": "its public half is built into the released desktop apps",
    "UNSUBSCRIBE_SECRET": "signs the unsubscribe links in mail already sent",
    "OUTLOOK_WEBHOOK_SECRET": "part of every live Outlook subscription",
    "GMAIL_WEBHOOK_TOKEN": "part of the Gmail push subscription",
    "INNGEST_SIGNING_KEY": "the Inngest server's own (pull-settings.sh copies it)",
    "INNGEST_EVENT_KEY": "the Inngest server's own (pull-settings.sh copies it)",
    "GPT_LIVE_TRUNK_SECRET": "the phone trunk sends it with every call",
    "GPT_LIVE_WEBHOOK_SECRET": "the voice provider signs its call webhooks with it",
    "LINEAR_WEBHOOK_SECRET": "Linear signs its webhooks with it",
    "GITHUB_WEBHOOK_SECRET": "a repository webhook to /api/webhooks/github signs with it",
    "TWILIO_ACCOUNT_SID": "the number, the messaging service and the trunk belong to that account",
    "TWILIO_AUTH_TOKEN": "Twilio signs its webhooks with the account's current token",
    "TWILIO_PHONE_NUMBER": "the number people already text",
    "TWILIO_MESSAGING_SERVICE_SID": "the service that number sends through",
    "STRIPE_SECRET_KEY": "the account and mode of the customers and prices stored",
    "GOOGLE_CLIENT_ID": "stored connections were made with that app",
    "MICROSOFT_CLIENT_ID": "stored connections were made with that app",
    "HUBSPOT_CLIENT_ID": "stored connections were made with that app",
    "ASANA_CLIENT_ID": "stored connections were made with that app",
    "JIRA_CLIENT_ID": "stored connections were made with that app",
    "LINEAR_CLIENT_ID": "stored connections were made with that app",
    "GITHUB_CLIENT_ID": "stored connections were made with that app",
}

MAY_BE_EMPTY = {
    "NEXT_PUBLIC_POSTHOG_HOST": "empty: the US cloud, through /ingest",
    "NEXT_PUBLIC_SITE_URL": "empty: the app's own address",
    "APP_DOWNLOAD_URL_WINDOWS": "empty: no Windows download is offered",
    "SENTRY_ORG": "read only by the build's source-map upload, which this image does not do",
    "SENTRY_PROJECT": "read only by the build's source-map upload, which this image does not do",
    "SLACK_SIGNING_SECRET": "empty: a button click Slack sends straight here, not through the connector, is refused",
    "CONNECT_ENVIRONMENT": "empty: production",
    "CONNECT_TEAM_ID": "empty: the project token is asked for without a team (measured working both ways)",
    "GATEWAY_USAGE_REPORTING": "empty: the admin's AI usage page opens on its log view",
    "GATEWAY_USER_TAGGING": "empty: no per-person tags in the AI Gateway's report",
    "AGENT_AUTO_ATTEMPT_ENABLED": "a switch: empty is off",
    "AGE_OUT_ENABLED": "a switch: empty is off",
    "RECONCILER_ENABLED": "a switch: empty is off",
    "RUN_SKILL_LOCAL_DISPATCH_ENABLED": "a switch: empty is off",
    "NI_FORWARD_OLD_DOMAIN": "a switch: empty is off (the forward from dial8.ai; only after the address moves)",
    # Until the app makes calls (../livekit; ../README.md step 23). All three or none.
    "LIVEKIT_URL": "empty: no audio or video calls",
    "LIVEKIT_API_KEY": "empty: no audio or video calls",
    "LIVEKIT_API_SECRET": "empty: no audio or video calls",
    "LIVEKIT_EGRESS": "a switch: empty is off (no call notes or recordings; on once Egress runs, ../README.md step 23)",
    # The coding agent's own sandbox runtime (../sandbox): built, not switched on.
    # The URLs and the key, all three or none; then the git gate's addresses too.
    "SANDBOX_RUNTIME_API_URL": "empty: the coding agent's sandbox is not on our own runtime",
    "SANDBOX_RUNTIME_TRAFFIC_URL": "empty: the coding agent's sandbox is not on our own runtime",
    "SANDBOX_RUNTIME_KEY": "empty: the coding agent's sandbox is not on our own runtime",
    "SANDBOX_RUNTIME_TEMPLATE": "empty: ni-coding-agent",
    "AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES": "empty: the git gate takes a run's credential from any address (what the hosted sandbox needs)",
}

SWITCH = {"NI_LIVE": "set by step 21 of ../README.md, never before"}

# What is off while a needed one is empty, where it is not obvious from the name.
EMPTY_MEANS = {
    "SANDBOX_ACCESS_TOKEN": "the cloud browser does not start, and no coding run works (its sandbox is just-bash)",
    "CONNECT_ACCESS_TOKEN": "Slack is off: the app cannot reach the connector",
    "CONNECT_PROJECT_ID": "Slack's events and button clicks are refused",
    "CLOUD_BROWSER_RELAY_ORIGIN": "the cloud browser does not start",
    "CLOUD_BROWSER_BASE_SNAPSHOT_ID": "the cloud browser does not start",
    "BROWSER_INTERNAL_SECRET": "it falls back to RUN_SKILL_INTERNAL_SECRET's key: give it a value of its own (any)",
    "EMAIL_FROM": "no mail is sent at all",
    "ADMIN_EMAILS": "nobody can open the admin pages",
    "DEEPGRAM_API_KEY": "live transcription in the browser is off",
    "GOOGLE_GENERATIVE_AI_API_KEY": "attachments are not indexed for search",
    "GPT_LIVE_API_KEY": "phone calls go unanswered",
    "HUBSPOT_CLIENT_SECRET": "HubSpot connections stop refreshing",
    "ASANA_CLIENT_SECRET": "Asana connections stop refreshing",
    "JIRA_CLIENT_SECRET": "Jira connections stop refreshing",
    "LINEAR_CLIENT_SECRET": "Linear connections stop refreshing",
    "GITHUB_CLIENT_SECRET": "new GitHub connections fail (existing ones keep working)",
}


def group(name):
    if name in SWITCH:
        return "switch"
    if name in MUST_MATCH:
        return "must match"
    if name in MAY_BE_EMPTY:
        return "may be empty"
    return "needed"


# --- reading the file as Compose reads it -------------------------------------------

def parse_env(text):
    """The values of a Compose env file, in the forms envfile.py writes."""
    values = {}
    for line in text.split("\n"):
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        name, v = m.groups()
        if len(v) >= 2 and v[0] == v[-1] == "'":
            v = v[1:-1]
        elif len(v) >= 2 and v[0] == v[-1] == '"':
            v = re.sub(r'\\(["\\$n])', lambda m: "\n" if m.group(1) == "n" else m.group(1), v[1:-1])
        else:
            v = v.split(" #", 1)[0].strip()
        values[name] = v
    return values


# --- the checks that need no network: pure, and tested ------------------------------

def node_base64(text):
    """Bytes as Node's Buffer.from(text, 'base64') reads them: whitespace and other
    characters skipped, the URL-safe alphabet accepted, padding optional, and
    the first '=' ending the data."""
    t = re.sub(r"[^A-Za-z0-9+/=_-]", "", text).replace("-", "+").replace("_", "/").split("=", 1)[0]
    if len(t) % 4 == 1:
        t = t[:-1]  # one character alone holds no whole byte; Node drops it
    return base64.b64decode(t + "=" * (-len(t) % 4))


def credential_key_opens(value, ciphertexts):
    """(opened, failed) over the app's `v1.<iv>.<tag>.<ciphertext>` values
    (web/src/lib/crypto/credentials.ts: AES-256-GCM, the key base64 32 bytes)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        key = node_base64(value)
    except ValueError:
        return 0, len(ciphertexts)
    if len(key) != 32:
        return 0, len(ciphertexts)
    aes = AESGCM(key)
    opened = failed = 0
    for c in ciphertexts:
        try:
            _, iv, tag, ct = c.split(".")
            aes.decrypt(base64.b64decode(iv), base64.b64decode(ct) + base64.b64decode(tag), None)
            opened += 1
        except Exception:
            failed += 1
    return opened, failed


def phone_code_key_variant(value, rows):
    """Which form of `value` reproduces a stored phone code hash
    (web/src/lib/sms/phone-verification.ts: HMAC-SHA256 of
    `phone-code:<user id>:<number>:<6 digits>`): "as entered", "with a line break"
    (it was stored with one), "without the line break", or None. rows are
    (user id, number, hash). Each row costs a million HMACs at most."""
    variants = [("as entered", value)]
    if value.endswith("\n"):
        variants.append(("without the line break", value.rstrip("\n")))
    else:
        variants.append(("with a line break", value + "\n"))
    for label, v in variants:
        key = v.encode()
        for user_id, phone, stored in rows:
            prefix = ("phone-code:%s:%s:" % (user_id, phone)).encode()
            stored = stored.strip().lower()
            for i in range(1_000_000):
                if hmac.digest(key, prefix + b"%06d" % i, "sha256").hex() == stored:
                    return label
    return None


def signing_public_key(value):
    """The public half (base64 SPKI DER, as /api/browser-exit/key serves it) of an
    Ed25519 PKCS#8 key in base64, or None (web/src/lib/cloud-browser/viewer-token.ts)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_private_key

    try:
        key = load_der_private_key(node_base64(value.strip()), None)
    except Exception:
        return None
    if not isinstance(key, Ed25519PrivateKey):
        return None
    return base64.b64encode(key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode()


def trunk_secrets(sip_urls):
    """The trunk secrets in origination addresses (`…?X-NI-Trunk=<hex>`, or the
    name used before the rename), as web/src/lib/calls/caller.ts reads them."""
    found = set()
    for url in sip_urls:
        for m in re.finditer(r"X-(?:NI|Dial8)-Trunk=([^&;>\s]+)", url or ""):
            found.add(urllib.parse.unquote(m.group(1)).strip())
    return found


def sender_domain(value):
    m = re.search(r"<([^<>@\s]+@[^<>@\s]+)>", value) or re.fullmatch(r"\s*([^<>@\s]+@[^<>@\s]+)\s*", value)
    return m.group(1).split("@")[1].lower() if m else None


# --- the live checks -----------------------------------------------------------------

DB_CONTAINER = os.environ.get("CHECK_DB_CONTAINER", "supabase-db")


def db(sql):
    r = subprocess.run(["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-F", "\t", "-c", sql],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("the database refused a read (%s)" % r.stderr.strip().split("\n")[0][:120])
    return [line.split("\t") for line in r.stdout.split("\n") if line]


def http(url, headers=None, auth=None, post=None, method=None):
    """(status, parsed JSON or None). GETs, or POSTs (with `post`, a JSON-able body,
    or method="POST" for none) used only to make a short-lived token; never logs
    what was sent."""
    h = {"User-Agent": "ni-check-settings", "Accept": "application/json"}
    h.update(headers or {})
    if auth:
        h["Authorization"] = "Basic " + base64.b64encode(("%s:%s" % auth).encode()).decode()
    data = None
    if post is not None:
        data = json.dumps(post).encode()
        h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method or ("POST" if post is not None else "GET")), timeout=20) as r:
            body = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None
    try:
        return status, json.loads(body)
    except ValueError:
        return status, None


def check_credential_key(env, _opts):
    sql = (
        "select access_token_encrypted from connected_mcp_server where access_token_encrypted like 'v1.%' "
        "union all select refresh_token_encrypted from connected_mcp_server where refresh_token_encrypted like 'v1.%' "
        "union all select access_token from user_oauth_tokens where access_token ~ '^v1\\.[A-Za-z0-9+/]{16}\\.[A-Za-z0-9+/]{22}==\\.' "
        "union all select refresh_token from user_oauth_tokens where refresh_token ~ '^v1\\.[A-Za-z0-9+/]{16}\\.[A-Za-z0-9+/]{22}==\\.'"
    )
    sql += " union all select a->>'bearer_token_encrypted' from flow, jsonb_array_elements(actions) a where a->>'bearer_token_encrypted' like 'v1.%'"
    for table, column in db("select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name like '%\\_enc' escape '\\'"):
        sql += " union all select %s from %s where %s like 'v1.%%'" % (column, table, column)
    ciphertexts = [r[0] for r in db(sql)]
    if not ciphertexts:
        return "nothing", "nothing stored to check it against"
    opened, failed = credential_key_opens(env["CREDENTIAL_ENCRYPTION_KEY"], ciphertexts)
    if failed == 0:
        return True, "opens all %d stored ciphertexts" % opened
    return False, "opens %d of %d stored ciphertexts: not production's key" % (opened, opened + failed)


def check_run_skill(env, _opts):
    # Ten, not one: codes a rehearsal made with its stand-in sit in the same table.
    rows = db("select user_id, phone_e164, code_hash from phone_verification order by created_at desc limit 10")
    if not rows:
        return "nothing", "no stored phone code to check it against"
    variant = phone_code_key_variant(env["RUN_SKILL_INTERNAL_SECRET"], rows)
    if variant == "as entered":
        return True, "reproduces a phone code production stored"
    if variant == "with a line break":
        return False, "right value, but production's ends in a line break: enter it again as RUN_SKILL_INTERNAL_SECRET+nl"
    if variant == "without the line break":
        return False, "right value, but entered with a line break production's does not have: enter it again without +nl"
    return False, "reproduces none of the %d newest stored phone codes: not production's value" % len(rows)


def check_signing_key(env, opts):
    public = signing_public_key(env["CLOUD_BROWSER_SIGNING_KEY"])
    if public is None:
        return False, "not an Ed25519 key in base64 PKCS#8"
    if not opts["pinned"]:
        return None, "no pinned key given to compare with"
    if public in opts["pinned"]:
        return True, "its public half is the one pinned in the desktop app"
    return False, "its public half is not the one pinned in the desktop app"


def check_stripe(env, _opts):
    key = env["STRIPE_SECRET_KEY"].strip()
    mode = "live" if key.startswith(("sk_live_", "rk_live_")) else "test" if key.startswith(("sk_test_", "rk_test_")) else "unknown"
    ids = [r[0] for r in db(
        "select stripe_customer_id from (select stripe_customer_id, updated_at from subscriptions "
        "where stripe_customer_id like 'cus\\_%' order by updated_at desc nulls last limit 5) s")]
    if not ids:
        return "nothing", "a %s-mode key; no stored customer to check it against" % mode
    codes = [http("https://api.stripe.com/v1/customers/" + urllib.parse.quote(i), {"Authorization": "Bearer " + key})[0] for i in ids]
    if 401 not in codes and 200 in codes:
        return True, "a %s-mode key that reads %d of the %d newest stored customers" % (mode, codes.count(200), len(ids))
    return False, "a %s-mode key; stored customers answered %s (401: a wrong key; 404: another account or mode)" % (mode, codes)


def twilio_auth(env):
    return env["TWILIO_ACCOUNT_SID"].strip(), env["TWILIO_AUTH_TOKEN"].strip()


def check_twilio(env, _opts):
    sid, token = twilio_auth(env)
    if not sid or not token:
        return None, "needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN"
    status, body = http("https://api.twilio.com/2010-04-01/Accounts/%s.json" % urllib.parse.quote(sid), auth=(sid, token))
    if status != 200:
        return False, "Twilio refused the account and token (%d)" % status
    notes = ["Twilio accepts the account and token (account %s)" % ((body or {}).get("status") or "?")]
    number = env.get("TWILIO_PHONE_NUMBER", "").strip()
    ok = True
    if number:
        status, body = http("https://api.twilio.com/2010-04-01/Accounts/%s/IncomingPhoneNumbers.json?PhoneNumber=%s" % (
            urllib.parse.quote(sid), urllib.parse.quote(number)), auth=(sid, token))
        found = status == 200 and bool((body or {}).get("incoming_phone_numbers"))
        ok = ok and found
        notes.append("the number is %s" % ("this account's" if found else "NOT this account's"))
    service = env.get("TWILIO_MESSAGING_SERVICE_SID", "").strip()
    if service:
        status, _ = http("https://messaging.twilio.com/v1/Services/" + urllib.parse.quote(service), auth=(sid, token))
        ok = ok and status == 200
        notes.append("the messaging service is %s" % ("this account's" if status == 200 else "NOT this account's (%d)" % status))
    return ok, "; ".join(notes)


def trunk_secrets_at_twilio(env):
    """The trunk secrets in the account's origination addresses, or None when Twilio cannot be read."""
    sid, token = twilio_auth(env)
    if not sid or not token:
        return None
    status, body = http("https://trunking.twilio.com/v1/Trunks?PageSize=50", auth=(sid, token))
    if status != 200:
        return None
    urls = []
    for trunk in (body or {}).get("trunks", []):
        link = (trunk.get("links") or {}).get("origination_urls")
        if link:
            status, page = http(link + "?PageSize=50", auth=(sid, token))
            if status != 200:
                return None
            urls += [o.get("sip_url") for o in (page or {}).get("origination_urls", [])]
    return trunk_secrets(urls)


def check_trunk(env, _opts):
    found = trunk_secrets_at_twilio(env)
    if found is None:
        return None, "checked once the Twilio account and token are in"
    if not found:
        return False, "no trunk of this Twilio account sends a trunk secret"
    if env["GPT_LIVE_TRUNK_SECRET"].strip() in found:
        return True, "the one the Twilio trunk sends"
    return False, "not the one the Twilio trunk sends"


def check_google(env, opts):
    model = opts["embedding_model"] or "gemini-embedding-001"
    status, _ = http("https://generativelanguage.googleapis.com/v1beta/models/" + urllib.parse.quote(model),
                     {"x-goog-api-key": env["GOOGLE_GENERATIVE_AI_API_KEY"].strip()})
    if status == 200:
        return True, "Google answers for the app's embedding model (%s)" % model
    return False, "Google answered %d for the app's embedding model (%s)" % (status, model)


def check_email_from(env, _opts):
    domain = sender_domain(env["EMAIL_FROM"])
    if not domain:
        return False, "not an address, nor 'Name <address>'"
    status, body = http("https://api.resend.com/domains", {"Authorization": "Bearer " + env.get("RESEND_API_KEY", "").strip()})
    if status != 200:
        return None, "the mail service did not list its domains (%d)" % status
    states = {(d.get("name") or "").lower(): d.get("status") for d in (body or {}).get("data", [])}
    if states.get(domain) == "verified":
        return True, "its domain is verified with the mail service"
    return False, "its domain is %s with the mail service" % (states.get(domain) or "not set up")


def check_sandbox(env, _opts):
    team, project = env.get("SANDBOX_TEAM_ID", "").strip(), env.get("SANDBOX_PROJECT_ID", "").strip()
    if not team or not project:
        return False, "needs SANDBOX_TEAM_ID and SANDBOX_PROJECT_ID too"
    # The listing the app's sandbox SDK makes (@vercel/sandbox, api-client.js
    # listSandboxes), at the API's own address: the SDK's address answers the app's
    # HTTP client but challenges this program's (403, x-vercel-mitigated), whatever
    # it says it is.
    status, _ = http("https://api.vercel.com/v2/sandboxes?limit=1&project=%s&teamId=%s" % (urllib.parse.quote(project), urllib.parse.quote(team)),
                     {"Authorization": "Bearer " + env["SANDBOX_ACCESS_TOKEN"].strip()})
    if status == 200:
        return True, "lists the project's sandboxes"
    if status in (401, 403):
        return False, "the sandbox service refused the token for this team and project (%d)" % status
    if trouble(status):
        return None, "the sandbox service could not be asked (%d): cannot tell" % status
    return False, "the sandbox service answered %d" % status


# --- the coding agent's own sandbox runtime ------------------------------------------

RUNTIME_URLS = ("SANDBOX_RUNTIME_API_URL", "SANDBOX_RUNTIME_TRAFFIC_URL")
RUNTIME_KEY = "SANDBOX_RUNTIME_KEY"
RUNTIME_GROUP = RUNTIME_URLS + (RUNTIME_KEY,)
HOSTED_SANDBOX = ("SANDBOX_ACCESS_TOKEN", "SANDBOX_TEAM_ID", "SANDBOX_PROJECT_ID")
GATE_ADDRESSES = "AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES"
# Where a private tunnel's end can be: the private IPv4 ranges, the shared range
# tunnels often use, and IPv6 unique local addresses.
TUNNEL_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"))


def runtime_url_problem(value):
    """None for an http:// URL whose host is a private address (the tunnel's end),
    else why not. Never quotes the value."""
    try:
        parts = urllib.parse.urlsplit(value.strip())
        host, _port = parts.hostname, parts.port
    except ValueError:
        return "not a URL"
    if parts.scheme != "http":
        return "not an http:// URL (the tunnel is the encryption; the runtime speaks plain HTTP on it)"
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return "its host is not an IP address (the runtime is reached at its tunnel address)"
    if not any(address.version == n.version and address in n for n in TUNNEL_NETWORKS):
        return "its host is not a private address: the runtime is reached only over the private tunnel"
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        return "has more than a scheme, an address and a port"
    return None


def runtime_key_shape_ok(value):
    """e2b_ followed by at least 32 hex digits, as the runtime makes its keys."""
    return re.fullmatch(r"e2b_[0-9a-fA-F]{32,}", value.strip()) is not None


def gate_address_problems(value):
    """How many entries of AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES are not IP addresses,
    and how many are (as the app reads it: comma or space separated, brackets and a
    zone id allowed)."""
    bad = good = 0
    for entry in re.split(r"[\s,]+", value.strip()):
        if not entry:
            continue
        e = entry[1:-1] if entry.startswith("[") and entry.endswith("]") else entry
        try:
            ipaddress.ip_address(e.split("%", 1)[0])
            good += 1
        except ValueError:
            bad += 1
    return bad, good


def runtime_group_missing(env):
    return [n for n in RUNTIME_GROUP if not env.get(n, "").strip()]


def check_runtime(env, _opts):
    """SANDBOX_RUNTIME_API_URL, for the whole group: the two URLs and the key set
    together and well formed, the git gate's addresses set and valid, the hosted
    sandbox's three unset; then the runtime itself, over the tunnel: its health
    check, and a listing of its sandboxes with the key (changes nothing)."""
    missing = runtime_group_missing(env)
    if missing:
        return False, "set without %s: the two URLs and the key, all three or none" % ", ".join(missing)
    for name in RUNTIME_URLS:
        problem = runtime_url_problem(env[name])
        if problem:
            return False, "%s %s" % (name, problem)
    if not runtime_key_shape_ok(env[RUNTIME_KEY]):
        return False, "%s is not e2b_ followed by at least 32 hex digits" % RUNTIME_KEY
    hosted = [n for n in HOSTED_SANDBOX if env.get(n, "").strip()]
    if hosted:
        return False, "set together with the hosted sandbox's %s: the coding agent refuses both at once" % ", ".join(hosted)
    addresses = env.get(GATE_ADDRESSES, "")
    bad, good = gate_address_problems(addresses)
    if not good and not bad:
        return False, "needs %s (the sandbox server's public addresses): the coding agent refuses to run on its own runtime without it" % GATE_ADDRESSES
    if bad:
        return False, "%s has %d entr%s that %s not an IP address" % (GATE_ADDRESSES, bad, "y" if bad == 1 else "ies", "is" if bad == 1 else "are")
    base = env["SANDBOX_RUNTIME_API_URL"].strip().rstrip("/")
    status, _ = http(base + "/health")
    if trouble(status):
        return None, "the runtime could not be asked over the tunnel (%d): cannot tell" % status
    if status != 200:
        return False, "the runtime's health check answered %d" % status
    status, _ = http(base + "/sandboxes", {"X-API-Key": env[RUNTIME_KEY].strip()})
    if status == 200:
        return True, "the runtime answers over the tunnel and accepts the key (it lists its sandboxes)"
    if status in (401, 403):
        return False, "the runtime refused the key (%d)" % status
    if trouble(status):
        return None, "the runtime could not be asked for its sandboxes (%d): cannot tell" % status
    return False, "the runtime answered %d to a listing of its sandboxes" % status


def check_runtime_part(name):
    """The traffic URL and the key: the group is proven by SANDBOX_RUNTIME_API_URL's
    check; here only that it is set at all, and the value's own shape."""
    def check(env, _opts):
        if not env.get("SANDBOX_RUNTIME_API_URL", "").strip():
            return False, "set without SANDBOX_RUNTIME_API_URL: the two URLs and the key, all three or none"
        if name == RUNTIME_KEY:
            if not runtime_key_shape_ok(env[name]):
                return False, "not e2b_ followed by at least 32 hex digits"
        else:
            problem = runtime_url_problem(env[name])
            if problem:
                return False, problem
        return None, None
    return check


def check_runtime_template(env, _opts):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", env["SANDBOX_RUNTIME_TEMPLATE"].strip()):
        return False, "not a template name (lowercase letters, digits, - and _)"
    if not env.get("SANDBOX_RUNTIME_API_URL", "").strip():
        return "warn", "set without our own runtime: nothing reads it"
    return None, None


def check_gate_addresses(env, _opts):
    bad, good = gate_address_problems(env[GATE_ADDRESSES])
    if bad:
        return False, "%d entr%s not an IP address: the git gate then refuses every coding run's clone and push" % (bad, "y is" if bad == 1 else "ies are")
    if not good:
        return None, None
    if not env.get("SANDBOX_RUNTIME_API_URL", "").strip():
        return "warn", ("set without our own runtime: the git gate then refuses the hosted sandbox's clones and pushes, "
                        "which come from other addresses")
    return None, None


SLACK_EVENTS_PATH = "/api/slack/events"
CONNECT_API = "https://api.vercel.com"


def trouble(status):
    """True for an answer that says nothing about the settings: the network, too
    many requests, or the other side's own failure."""
    return status == 0 or status == 429 or status >= 500


def destinations_verdict(body, project):
    """(ok, note) for the connector's own metadata: one of its trigger destinations
    must be `project` at the events path. None when the shape is not known here."""
    destinations = body.get("triggerDestinations") if isinstance(body, dict) else None
    if not isinstance(destinations, list) or not all(isinstance(d, dict) for d in destinations):
        return None, "the connector's trigger destinations are not in a form known here: cannot tell"
    if any(d.get("projectId") == project and d.get("path") == SLACK_EVENTS_PATH for d in destinations):
        return True, None
    return False, "the connector forwards no events to CONNECT_PROJECT_ID at %s" % SLACK_EVENTS_PATH


def project_token(env):
    """(token, None) or (None, (ok, note)): step 1, the project token the app makes
    with CONNECT_ACCESS_TOKEN (web/src/lib/slack/connect-auth.ts, the request
    @vercel/oidc's token-util.js getVercelOidcToken makes), sent as the app sends
    it: the team named only when CONNECT_TEAM_ID is set, and no body."""
    access, project = env["CONNECT_ACCESS_TOKEN"].strip(), env.get("CONNECT_PROJECT_ID", "").strip()
    team = env.get("CONNECT_TEAM_ID", "").strip()
    url = "%s/v1/projects/%s/token?source=vercel-oidc-refresh" % (CONNECT_API, urllib.parse.quote(project, safe=""))
    if team:
        url += "&teamId=" + urllib.parse.quote(team, safe="")
    status, body = http(url, {"Authorization": "Bearer " + access}, method="POST")
    if trouble(status):
        return None, (None, "step 1, the project token: could not be asked (%d): cannot tell" % status)
    token = body.get("token") if status == 200 and isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        return None, (False, "step 1, the project token: answered %d without one (the access token is not accepted for "
                             "CONNECT_PROJECT_ID, or the team is wrong)" % status)
    return token, None


def check_connect(env, _opts):
    """The app's real path to a Slack login, in three steps, stopping at the first
    that fails: (1) the project token, (2) with it, the Slack connector's metadata
    (it must forward its events to CONNECT_PROJECT_ID; its default installation is
    used next), (3) with it, a Slack token for that installation, which Slack's
    auth.test must accept for the same team. A metadata read alone proved nothing:
    the access token reads it, yet Connect refuses it for a token. No credential
    from any answer is printed or put in a note."""
    if not env["CONNECT_ACCESS_TOKEN"].strip():
        return False, "holds only whitespace: the app reads it as empty"
    connector, project = env.get("SLACK_CONNECTOR", "").strip(), env.get("CONNECT_PROJECT_ID", "").strip()
    if not connector or not project:
        return False, "needs SLACK_CONNECTOR and CONNECT_PROJECT_ID too"
    token, failed = project_token(env)
    if failed:
        return failed
    bearer = {"Authorization": "Bearer " + token}
    path = urllib.parse.quote(connector, safe="!*'()")

    # Step 2: what the app's client asks for a connector's metadata (connector.js getConnectorMetadata).
    status, body = http("%s/v1/connect/connectors/%s" % (CONNECT_API, path), bearer)
    if trouble(status):
        return None, "step 2, the connector: could not be asked (%d): cannot tell" % status
    if status != 200:
        return False, "step 2, the connector: answered %d to the project token (not attached to the project, or SLACK_CONNECTOR is wrong)" % status
    ok, note = destinations_verdict(body, project)
    if ok is not True:
        return ok, "step 2, the connector: " + note
    installation = body.get("defaultInstallationId")
    if not isinstance(installation, str) or not installation:
        return None, "step 2, the connector: names no default installation: cannot tell"

    # Step 3: what the app's client asks for a bot token (token.js getTokenResponse), then Slack itself.
    status, body = http("%s/v1/connect/token/%s" % (CONNECT_API, path), bearer,
                        post={"subject": {"type": "app"}, "installationId": installation, "scopes": ["*"]})
    if trouble(status):
        return None, "step 3, the Slack token: could not be asked (%d): cannot tell" % status
    slack = body.get("token") if status == 200 and isinstance(body, dict) else None
    if not isinstance(slack, str) or not slack:
        return False, "step 3, the Slack token: the connector answered %d without one" % status
    status, body = http("https://slack.com/api/auth.test", {"Authorization": "Bearer " + slack})
    if trouble(status):
        return None, "step 3, Slack: could not be asked (%d): cannot tell" % status
    if not (isinstance(body, dict) and body.get("ok") is True):
        return False, "step 3, Slack: refused the token the connector gave (%s)" % (
            body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), str) else status)
    if body.get("team_id") != installation:
        return False, "step 3, Slack: the token is for another team than the connector's default installation"
    return True, "a project token, the connector forwarding to CONNECT_PROJECT_ID, and a Slack token Slack accepts for the installation"


def check_no_wildcard(name):
    def check(env, _opts):
        if "*" in env[name]:
            return False, "contains *: the app then refuses every event the connector forwards"
        return None, None
    return check


def check_deepgram(env, _opts):
    status, body = http("https://api.deepgram.com/v1/projects", {"Authorization": "Token " + env["DEEPGRAM_API_KEY"].strip()})
    if status == 200 and (body or {}).get("projects"):
        return True, "Deepgram accepts it"
    return False, "Deepgram answered %d" % status


def check_openai(env, _opts):
    status, _ = http("https://api.openai.com/v1/models", {"Authorization": "Bearer " + env["GPT_LIVE_API_KEY"].strip()})
    if status == 200:
        return True, "OpenAI accepts it"
    return False, "OpenAI answered %d" % status


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def livekit_token(key, secret, now, ttl=300):
    """An access token for LiveKit's server API, as livekit-server-sdk makes one
    (AccessToken: HS256, the API key as issuer, the grants under "video"). This one
    may only list rooms."""
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {"iss": key, "nbf": int(now) - 10, "exp": int(now) + ttl, "video": {"roomList": True}}
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signature = hmac.digest(secret.encode(), ("%s.%s" % (header, body)).encode(), "sha256")
    return "%s.%s.%s" % (header, body, b64url(signature))


def livekit_api_base(url):
    """https://<host> for the wss://<host> browsers connect to, or None when the
    value is not one: the app's pages are served over HTTPS, so a browser refuses
    anything but wss:// to a server of another origin."""
    m = re.fullmatch(r"wss://([A-Za-z0-9.-]+(?::[0-9]{1,5})?)/?", url.strip())
    return "https://" + m.group(1) if m else None


def livekit_list_rooms(base, key, secret, now=None):
    """(ok, note) for one RoomService call (ListRooms) at `base` with a token made
    from key and secret: the server must accept it. Changes nothing there."""
    token = livekit_token(key, secret, time.time() if now is None else now)
    status, body = http(base + "/twirp/livekit.RoomService/ListRooms", {"Authorization": "Bearer " + token}, post={})
    if status == 200 and isinstance(body, dict):
        rooms = body.get("rooms") or []
        return True, "LiveKit accepts a token made with the key and secret (%d room%s open)" % (len(rooms), "" if len(rooms) == 1 else "s")
    if status == 401:
        return False, "LiveKit refused a token made with them (401): not the key and secret in ../livekit/.env"
    if trouble(status):
        return None, "LiveKit could not be asked (%d): cannot tell" % status
    return False, "LiveKit answered %d to its own API (is the address its, and Caddy's LIVEKIT_HOST set?)" % status


def check_livekit(env, _opts):
    """The URL the browsers get, and the key pair the app signs their tokens with,
    proven together: a token made here as the app makes one, sent to that server."""
    key, secret = env.get("LIVEKIT_API_KEY", "").strip(), env.get("LIVEKIT_API_SECRET", "").strip()
    if not key or not secret:
        return False, "needs LIVEKIT_API_KEY and LIVEKIT_API_SECRET too (../livekit/make-keys.sh writes them)"
    base = livekit_api_base(env["LIVEKIT_URL"])
    if base is None:
        return False, "not wss://<host name>: browsers on the app's HTTPS pages refuse anything else"
    return livekit_list_rooms(base, key, secret)


def check_livekit_key(env, _opts):
    if not env.get("LIVEKIT_URL", "").strip():
        return False, "set without LIVEKIT_URL: all three or none"
    return None, None  # proven by LIVEKIT_URL's check


def check_livekit_egress(env, _opts):
    """`on` or empty, and `on` only with calls set up: Egress takes its jobs through
    the same LiveKit. Whether Egress itself runs is not visible from here (LiveKit's
    API answers the same without it); step 23's test recording is the proof."""
    value = env["LIVEKIT_EGRESS"].strip()
    if value != "on":
        return False, "is %r: only on, or empty for off" % (value[:12],)
    if not env.get("LIVEKIT_URL", "").strip():
        return False, "on without LIVEKIT_URL: Egress works through the calls' LiveKit"
    return None, None


CHECKS = {
    "CREDENTIAL_ENCRYPTION_KEY": check_credential_key,
    "RUN_SKILL_INTERNAL_SECRET": check_run_skill,
    "CLOUD_BROWSER_SIGNING_KEY": check_signing_key,
    "STRIPE_SECRET_KEY": check_stripe,
    "TWILIO_AUTH_TOKEN": check_twilio,
    "GPT_LIVE_TRUNK_SECRET": check_trunk,
    "GOOGLE_GENERATIVE_AI_API_KEY": check_google,
    "EMAIL_FROM": check_email_from,
    "SANDBOX_ACCESS_TOKEN": check_sandbox,
    "CONNECT_ACCESS_TOKEN": check_connect,
    "CONNECT_PROJECT_ID": check_no_wildcard("CONNECT_PROJECT_ID"),
    "CONNECT_ENVIRONMENT": check_no_wildcard("CONNECT_ENVIRONMENT"),
    "DEEPGRAM_API_KEY": check_deepgram,
    "GPT_LIVE_API_KEY": check_openai,
    "LIVEKIT_URL": check_livekit,
    "LIVEKIT_API_KEY": check_livekit_key,
    "LIVEKIT_API_SECRET": check_livekit_key,
    "LIVEKIT_EGRESS": check_livekit_egress,
    "SANDBOX_RUNTIME_API_URL": check_runtime,
    "SANDBOX_RUNTIME_TRAFFIC_URL": check_runtime_part("SANDBOX_RUNTIME_TRAFFIC_URL"),
    "SANDBOX_RUNTIME_KEY": check_runtime_part("SANDBOX_RUNTIME_KEY"),
    "SANDBOX_RUNTIME_TEMPLATE": check_runtime_template,
    "AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES": check_gate_addresses,
}


# --- the report -----------------------------------------------------------------------

def state_of(value):
    if value == "":
        return "empty"
    if value.startswith("rehearsal-"):
        return "STAND-IN"
    return "set (%d)" % len(value)


def report(env, results):
    """Lines to print, what keeps Gate 1's settings from being met, and the needed
    settings whose check could not run. results maps a name to (ok, note) for the
    checks that ran; ok is True, False, None (could not run), "nothing" (no
    stored data to prove it against) or "warn" (said, but blocks nothing)."""
    lines, blockers, unchecked = [], [], []
    for title, key in (("Must be the value the earlier host has", "must match"), ("Needed (any working value)", "needed"),
                       ("May stay empty", "may be empty"), ("Set by the switch itself", "switch")):
        names = [n for n in env if group(n) == key]
        if not names:
            continue
        lines.append("")
        lines.append("%s:" % title)
        quiet = 0
        for n in names:
            st = state_of(env[n])
            ok, note = results.get(n, (None, None))
            if key == "switch":
                lines.append("   %-32s %s (%s)" % (n, st if st != "empty" else "empty: a rehearsal", SWITCH[n]))
                continue
            if st == "empty":
                if key == "may be empty":
                    lines.append("   %-32s empty    %s" % (n, MAY_BE_EMPTY[n]))
                    continue
                why = MUST_MATCH.get(n) or EMPTY_MEANS.get(n) or ""
                lines.append("   %-32s EMPTY    %s" % (n, why))
                blockers.append("%s is empty" % n)
                continue
            if st == "STAND-IN":
                lines.append("   %-32s STAND-IN a rehearsal's value: replace it" % n)
                blockers.append("%s holds a rehearsal's stand-in" % n)
                continue
            if note is None:
                quiet += 1
                continue
            mark = {True: "ok      ", False: "WRONG   ", None: "UNCHECKED", "nothing": "unproven", "warn": "WARNING "}[ok]
            lines.append("   %-32s %s %s" % (n, mark, note))
            if ok is False:
                blockers.append("%s: %s" % (n, note))
            elif ok is None and key == "must match":
                # A proof that could not run proves nothing: the gate waits for it.
                blockers.append("%s is unproven (%s)" % (n, note))
            elif ok is None:
                unchecked.append(n)
        if quiet:
            lines.append("   (%d more set, with nothing to check them against from here)" % quiet)
    return lines, blockers, unchecked


def main(argv):
    if len(argv) < 2:
        sys.exit("usage: check_settings.py <env file> [--names-only] [--fill <envfile.py>] [--pinned <key> ...] [--embedding-model <name>]")
    path = argv[1]
    opts = {"names_only": False, "fill": None, "pinned": [], "embedding_model": None}
    i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--names-only":
            opts["names_only"] = True
        elif a in ("--fill", "--pinned", "--embedding-model") and i + 1 < len(argv):
            i += 1
            if a == "--pinned":
                opts["pinned"].append(argv[i])
            else:
                opts[a[2:].replace("-", "_")] = argv[i]
        else:
            sys.exit("check_settings: unknown argument %s" % a)
        i += 1
    with open(path) as f:
        env = parse_env(f.read())

    if opts["fill"] and not env.get("GPT_LIVE_TRUNK_SECRET") and "GPT_LIVE_TRUNK_SECRET" in env:
        found = trunk_secrets_at_twilio(env)
        if found and len(found) == 1:
            r = subprocess.run([sys.executable, "-I", opts["fill"], "apply", path], input=json.dumps({"GPT_LIVE_TRUNK_SECRET": found.pop()}), text=True)
            if r.returncode != 0:
                sys.exit(r.returncode)
            print("Brought GPT_LIVE_TRUNK_SECRET from the Twilio trunk's origination address.")
            with open(path) as f:
                env = parse_env(f.read())
        elif found is None:
            print("GPT_LIVE_TRUNK_SECRET not brought: the Twilio account and token are not in yet, or Twilio refused them.")
        else:
            print("GPT_LIVE_TRUNK_SECRET not brought: %d different trunk secrets found at Twilio; enter the right one by hand." % len(found))

    results = {}
    if not opts["names_only"]:
        for name, check in CHECKS.items():
            if env.get(name) and not env[name].startswith("rehearsal-"):
                try:
                    results[name] = check(env, opts)
                except Exception as e:  # a check that cannot run says so; it never shows a value
                    results[name] = (None, "could not be checked: %s" % type(e).__name__)
    lines, blockers, unchecked = report(env, results)
    total = len(env)
    empty = sum(1 for v in env.values() if v == "")
    print("%s: %d settings, %d empty, %d holding a stand-in." % (path, total, empty, sum(1 for v in env.values() if v.startswith("rehearsal-"))))
    for line in lines:
        print(line)
    print()
    if opts["names_only"]:
        print("Values not checked (names only). deploy/app/check-settings.sh checks them.")
    if blockers:
        print("Gate 1, the settings: NOT MET (%d):" % len(blockers))
        for b in blockers:
            print("   - " + b)
    else:
        print("Gate 1, the settings: met%s%s." % (" by name" if opts["names_only"] else "",
              "; these could not be checked from here: " + ", ".join(unchecked) if unchecked else ""))


if __name__ == "__main__":
    main(sys.argv)
