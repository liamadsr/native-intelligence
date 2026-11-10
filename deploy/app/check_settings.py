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
               read-only call can tell.
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
import json
import os
import re
import subprocess
import sys
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
    "SLACK_SIGNING_SECRET": "Slack cannot run off the earlier host yet (../README.md step 21, Gate 1)",
    "GITHUB_WEBHOOK_SECRET": "needed only once a repository's webhook points at /api/webhooks/github",
    "GATEWAY_USAGE_REPORTING": "empty: the admin's AI usage page opens on its log view",
    "GATEWAY_USER_TAGGING": "empty: no per-person tags in the AI Gateway's report",
    "AGENT_AUTO_ATTEMPT_ENABLED": "a switch: empty is off",
    "AGE_OUT_ENABLED": "a switch: empty is off",
    "RECONCILER_ENABLED": "a switch: empty is off",
    "RUN_SKILL_LOCAL_DISPATCH_ENABLED": "a switch: empty is off",
}

SWITCH = {"NI_LIVE": "set by step 21 of ../README.md, never before"}

# What is off while a needed one is empty, where it is not obvious from the name.
EMPTY_MEANS = {
    "SANDBOX_ACCESS_TOKEN": "the cloud browser does not start",
    "CLOUD_BROWSER_RELAY_ORIGIN": "the cloud browser does not start",
    "CLOUD_BROWSER_BASE_SNAPSHOT_ID": "the cloud browser does not start",
    "BROWSER_INTERNAL_SECRET": "the cloud browser does not start (any value does)",
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

def credential_key_opens(value, ciphertexts):
    """(opened, failed) over the app's `v1.<iv>.<tag>.<ciphertext>` values
    (web/src/lib/crypto/credentials.ts: AES-256-GCM, the key base64 32 bytes)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        key = base64.b64decode(re.sub(r"\s", "", value))
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
        key = load_der_private_key(base64.b64decode(value.strip()), None)
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
        for m in re.finditer(r"X-(?:NI|Dial8)-Trunk=([0-9A-Fa-f]+)", url or ""):
            found.add(m.group(1))
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


def http(url, headers=None, auth=None):
    """(status, parsed JSON or None). Read-only GETs; never logs what was sent."""
    h = {"User-Agent": "ni-check-settings", "Accept": "application/json"}
    h.update(headers or {})
    if auth:
        h["Authorization"] = "Basic " + base64.b64encode(("%s:%s" % auth).encode()).decode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=20) as r:
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
    for table, column in db("select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name like '%\\_enc' escape '\\'"):
        sql += " union all select %s from %s where %s like 'v1.%%'" % (column, table, column)
    ciphertexts = [r[0] for r in db(sql)]
    if not ciphertexts:
        return None, "nothing stored to check it against"
    opened, failed = credential_key_opens(env["CREDENTIAL_ENCRYPTION_KEY"], ciphertexts)
    if failed == 0:
        return True, "opens all %d stored ciphertexts" % opened
    return False, "opens %d of %d stored ciphertexts: not production's key" % (opened, opened + failed)


def check_run_skill(env, _opts):
    rows = db("select user_id, phone_e164, code_hash from phone_verification order by created_at desc limit 3")
    if not rows:
        return None, "no stored phone code to check it against"
    variant = phone_code_key_variant(env["RUN_SKILL_INTERNAL_SECRET"], rows)
    if variant == "as entered":
        return True, "reproduces a phone code production stored"
    if variant == "with a line break":
        return False, "right value, but production's ends in a line break: enter it again as RUN_SKILL_INTERNAL_SECRET+nl"
    if variant == "without the line break":
        return False, "right value, but entered with a line break production's does not have: enter it again without +nl"
    return False, "reproduces none of the %d stored phone codes: not production's value" % len(rows)


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
        "select stripe_customer_id from subscriptions where stripe_customer_id like 'cus\\_%' "
        "union select stripe_customer_id from ai_user_credits where stripe_customer_id like 'cus\\_%' limit 3")]
    if not ids:
        return None, "a %s-mode key; no stored customer to check it against" % mode
    codes = [http("https://api.stripe.com/v1/customers/" + urllib.parse.quote(i), {"Authorization": "Bearer " + key})[0] for i in ids]
    if all(c == 200 for c in codes):
        return True, "a %s-mode key that reads the %d stored customers it was tried on" % (mode, len(ids))
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
    status, _ = http("https://api.vercel.com/v1/sandboxes?limit=1&project=%s&teamId=%s" % (urllib.parse.quote(project), urllib.parse.quote(team)),
                     {"Authorization": "Bearer " + env["SANDBOX_ACCESS_TOKEN"].strip()})
    if status == 200:
        return True, "lists the project's sandboxes"
    return False, "the sandbox service answered %d (403: the token's scope does not include the team)" % status


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
    "DEEPGRAM_API_KEY": check_deepgram,
    "GPT_LIVE_API_KEY": check_openai,
}


# --- the report -----------------------------------------------------------------------

def state_of(value):
    if value == "":
        return "empty"
    if value.startswith("rehearsal-"):
        return "STAND-IN"
    return "set (%d)" % len(value)


def report(env, results):
    """Lines to print, and what keeps Gate 1's settings from being met. results maps
    a name to (ok, note) for the checks that ran."""
    lines, blockers = [], []
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
            mark = {True: "ok      ", False: "WRONG   ", None: "unchecked"}[ok]
            lines.append("   %-32s %s %s" % (n, mark, note))
            if ok is False:
                blockers.append("%s: %s" % (n, note))
        if quiet:
            lines.append("   (%d more set, with nothing to check them against from here)" % quiet)
    return lines, blockers


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
    lines, blockers = report(env, results)
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
        print("Gate 1, the settings: met%s." % (" by name" if opts["names_only"] else ""))


if __name__ == "__main__":
    main(sys.argv)
