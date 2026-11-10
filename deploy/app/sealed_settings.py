#!/usr/bin/env python3
"""The server's half of the sealed copy: production's write-only settings, brought
from the app's earlier host into deploy/app/.env without anyone seeing them
(README.md in this folder, "Sealed copy"; ../README.md step 21, Gate 1).

  sealed_settings.py new-key <key file>
      Makes an X25519 key pair. The private half is written to <key file>, root
      only, and never leaves this server; the public half is printed (it is not a
      secret) to be committed as web/scripts/seal-settings.pub. Refuses to replace
      a key that is there.

  sealed_settings.py open <key file> <env file> <envfile.py> <deployment id> <created ms> [--keep-key]
      Reads the block web/scripts/seal-settings.mjs printed into a production
      build's log, on stdin. The public key is public, so anyone can seal a block:
      it is accepted only if it names <deployment id>, the deployment whose log it
      was cut from, and was sealed within two hours of that deployment's creation. Opens it with the private half, writes the values it
      holds for NAMES into <env file> through envfile.py (only names the file has
      a line for), says per name whether it filled an empty value, replaced
      another or found the same, never what. Then deletes the private half, unless
      --keep-key: a block can be opened once.

Needs python3 and its cryptography package (Ubuntu's python3-cryptography).
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys

INFO = b"ni-sealed-settings-v1"
BEGIN = "-----BEGIN NI SEALED SETTINGS-----"
END = "-----END NI SEALED SETTINGS-----"

# The same list as NAMES in web/scripts/seal-settings.mjs (a test holds them equal).
NAMES = [
    "ADMIN_EMAILS", "AGENT_RUN_INTERNAL_SECRET", "ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET",
    "BROWSER_INTERNAL_SECRET", "CHAT_INTERNAL_SECRET", "CLOUD_BROWSER_BASE_SNAPSHOT_ID",
    "CLOUD_BROWSER_SIGNING_KEY", "CREDENTIAL_ENCRYPTION_KEY", "DEEPGRAM_API_KEY", "EMAIL_FROM",
    "GATEWAY_USAGE_REPORTING", "GATEWAY_USER_TAGGING", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET", "GOOGLE_GENERATIVE_AI_API_KEY", "GPT_LIVE_API_KEY", "GPT_LIVE_TRUNK_SECRET",
    "GPT_LIVE_WEBHOOK_SECRET", "HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET", "JIRA_CLIENT_ID",
    "JIRA_CLIENT_SECRET", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET", "LOCAL_AGENT_TOKEN_SECRET",
    "RUN_SKILL_INTERNAL_SECRET", "SENTRY_ORG", "SENTRY_PROJECT", "SLACK_SIGNING_SECRET",
    "STRIPE_SECRET_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
]


def die(message):
    sys.exit("sealed: " + message)


def shown(value):
    """A field from the block, safe to print: no escape sequences reach the terminal."""
    return re.sub(r"[^\w.:+-]", "?", str(value))[:80]


def kid_of(public_raw):
    return hashlib.sha256(public_raw).hexdigest()[:16]


def new_key():
    """(private PEM bytes, public base64 SPKI, kid)."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

    key = X25519PrivateKey.generate()
    pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    public = key.public_key()
    spki = base64.b64encode(public.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode()
    return pem, spki, kid_of(public.public_bytes(Encoding.Raw, PublicFormat.Raw))


def extract_block_text(text):
    """The body of the one sealed block in a build log's text, its lines kept."""
    starts = [m.start() for m in re.finditer(re.escape(BEGIN), text)]
    if len(starts) != 1:
        die("expected one sealed block, found %d." % len(starts))
    rest = text[starts[0] + len(BEGIN):]
    if END not in rest:
        die("the sealed block has no end: the log was cut short.")
    return rest.split(END, 1)[0].strip()


def extract_block(text):
    """The one sealed block in a build log's text, as its base64 body, or an error."""
    return re.sub(r"\s", "", extract_block_text(text))


def open_block(body, private_pem):
    """The sealed object ({values, sealedAt, commit, deployment, env}) for a block's body."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    key = serialization.load_pem_private_key(private_pem, None)
    if not isinstance(key, X25519PrivateKey):
        die("the key file does not hold an X25519 key.")
    try:
        env = json.loads(base64.b64decode(body))
        epk, iv, ct, tag = (base64.b64decode(env[k]) for k in ("epk", "iv", "ct", "tag"))
    except (ValueError, KeyError, TypeError):
        die("the block is not a sealed block (cut or changed?).")
    if env.get("v") != 1:
        die("a sealed block of a version this program does not know.")
    rpk = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    kid = kid_of(rpk)
    if env.get("kid") != kid:
        die("the block was sealed to key %s, not to this server's key %s." % (shown(env.get("kid")), kid))
    try:
        shared = key.exchange(X25519PublicKey.from_public_bytes(epk))
    except ValueError:
        die("the block's key exchange is not valid.")
    aes = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk + rpk, info=INFO).derive(shared)
    try:
        sealed = json.loads(AESGCM(aes).decrypt(iv, ct + tag, INFO + b":" + kid.encode()))
    except Exception:
        die("the block does not open with this server's key: it was changed, or sealed for another.")
    if sealed.get("env") != "production" or not isinstance(sealed.get("values"), dict):
        die("the block is not from a production build.")
    for field in ("sealedAt", "commit", "deployment"):
        if sealed.get(field) is not None and not isinstance(sealed.get(field), str):
            die("the block's %s is not text." % field)
    return sealed


def check_origin(sealed, deployment_id, created_ms):
    """The block must name the deployment it was cut from and be sealed while it
    was built: a block planted in another log, or an old one, is refused."""
    import datetime

    if sealed.get("deployment") != deployment_id:
        die("the block names deployment %s, not %s, whose log it came from." % (shown(sealed.get("deployment")), shown(deployment_id)))
    try:
        sealed_ms = datetime.datetime.fromisoformat(sealed["sealedAt"].replace("Z", "+00:00")).timestamp() * 1000
    except (KeyError, AttributeError, ValueError):
        die("the block has no time it was sealed.")
    if not 0 <= sealed_ms - created_ms <= 2 * 3600 * 1000:
        die("the block was not sealed while that deployment was built.")


def parse_env(text):
    """The values of a Compose env file, in the forms envfile.py writes (as check_settings.py)."""
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


def plan(sealed_values, current):
    """What to write: {name: value}, and a report per name ("filled", "replaced",
    "the same", "not in the block", "no line in the file"), never a value."""
    write, report = {}, {}
    for name in NAMES:
        if name not in sealed_values:
            report[name] = "not in the block"
            continue
        value = sealed_values[name]
        if not isinstance(value, str):
            die("%s in the block is not a string." % name)
        if name not in current:
            report[name] = "no line in the file"
        elif current[name] == value:
            report[name] = "the same"
        else:
            report[name] = "filled" if current[name] == "" else "replaced"
            write[name] = value
    return write, report


def forget_key(path):
    """Overwrite, then delete: the block is not to be opened twice."""
    size = os.path.getsize(path)
    with open(path, "r+b") as f:
        f.write(os.urandom(size))
        f.flush()
        os.fsync(f.fileno())
    os.unlink(path)


def main(argv):
    if len(argv) >= 3 and argv[1] == "new-key":
        path = argv[2]
        if os.path.exists(path):
            die("%s is there already; a key is never replaced here (delete it first, knowing that a block sealed to it can then not be opened)." % path)
        os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
        pem, spki, kid = new_key()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        print("key %s: private half in %s (mode 600); public half for web/scripts/seal-settings.pub:" % (kid, path))
        print(spki)
        return
    if len(argv) >= 7 and argv[1] == "open":
        key_path, env_path, envfile_py, deployment_id = argv[2:6]
        try:
            created_ms = int(argv[6])
        except ValueError:
            die("the deployment's creation time is not a number.")
        keep = "--keep-key" in argv[7:]
        if not os.path.exists(key_path):
            die("no private key at %s: it was used once already, or never made." % key_path)
        with open(key_path, "rb") as f:
            pem = f.read()
        sealed = open_block(extract_block(sys.stdin.read()), pem)
        check_origin(sealed, deployment_id, created_ms)
        with open(env_path) as f:
            current = parse_env(f.read())
        write, report = plan(sealed["values"], current)
        if write:
            r = subprocess.run([sys.executable, "-I", envfile_py, "apply", env_path], input=json.dumps(write), text=True)
            if r.returncode != 0:
                die("envfile.py refused; nothing more was done (the key is kept).")
        # Written: from here the key goes whatever happens, unless asked to keep it.
        try:
            print("Sealed %s by a production build of %s (deployment %s)." % (
                shown(sealed.get("sealedAt")), shown((sealed.get("commit") or "?")[:8]), shown(sealed.get("deployment"))))
            for name in NAMES:
                value = sealed["values"].get(name)
                print("   %-32s %s%s" % (name, report[name], " (%d characters)" % len(value) if isinstance(value, str) else ""))
        finally:
            if keep:
                print("The private key is kept (--keep-key).")
            else:
                forget_key(key_path)
                print("The private key is deleted: this block, and any other sealed to it, can no longer be opened.")
        return
    if len(argv) == 2 and argv[1] == "cut":
        # Here, on your own machine: a build's log events (JSON, the earlier host's
        # API) on stdin, the block alone on stdout.
        try:
            events = json.load(sys.stdin)
        except ValueError:
            die("the build log did not arrive as JSON.")
        text = "\n".join((e.get("text") or "") for e in events if isinstance(e, dict))
        print(BEGIN + "\n" + extract_block_text(text) + "\n" + END)
        return
    if len(argv) in (2, 3) and argv[1] == "production-id":
        # Here: a deployment (JSON) on stdin; its id if it is a production one.
        try:
            d = json.load(sys.stdin)
        except ValueError:
            die("the deployment did not arrive as JSON.")
        if d.get("target") != "production" or not d.get("id") or not isinstance(d.get("createdAt"), int):
            die("not a production deployment.")
        project = argv[2] if len(argv) > 2 else ""
        if d.get("projectId") != project:
            die("that deployment is not the app project's (%s)." % shown(project))
        print(d["id"], d["createdAt"])
        return
    die("usage: sealed_settings.py new-key <key file> | open <key file> <env file> <envfile.py> <deployment id> <created ms> [--keep-key] | cut | production-id <project id>")


if __name__ == "__main__":
    main(sys.argv)
