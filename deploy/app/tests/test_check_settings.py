"""Tests for check_settings.py: python3 -m unittest discover -s deploy/app/tests

Every key, number and id here is made up. Needs the cryptography package (Ubuntu's
python3-cryptography, as on the server).
"""
import base64
import contextlib
import hmac
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import check_settings as cs  # noqa: E402

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat  # noqa: E402


def app_ciphertext(key, plaintext):
    """What web/src/lib/crypto/credentials.ts writes: v1.<iv>.<tag>.<ciphertext>."""
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    ct, tag = sealed[:-16], sealed[-16:]
    return ".".join(["v1", base64.b64encode(iv).decode(), base64.b64encode(tag).decode(), base64.b64encode(ct).decode()])


def phone_hash(key, user_id, phone, code):
    """What web/src/lib/sms/phone-verification.ts stores."""
    return hmac.new(key.encode(), ("phone-code:%s:%s:%s" % (user_id, phone, code)).encode(), "sha256").hexdigest()


USER = "00000000-0000-4000-8000-000000000001"
PHONE = "+15555550101"


class ParseEnv(unittest.TestCase):
    def test_reads_the_forms_envfile_writes(self):
        env = cs.parse_env("A=plain\nB='quoted value'\nC=\"line\\n\"\nD=\nE=bare # a comment\n# F=no\n")
        self.assertEqual(env, {"A": "plain", "B": "quoted value", "C": "line\n", "D": "", "E": "bare"})


class Groups(unittest.TestCase):
    def test_groups(self):
        self.assertEqual(cs.group("NI_LIVE"), "switch")
        self.assertEqual(cs.group("CREDENTIAL_ENCRYPTION_KEY"), "must match")
        self.assertEqual(cs.group("SENTRY_ORG"), "may be empty")
        self.assertEqual(cs.group("SANDBOX_ACCESS_TOKEN"), "needed")
        # A new value is fine for it: only cloud browsers running at the switch hold tokens made with it.
        self.assertEqual(cs.group("BROWSER_INTERNAL_SECRET"), "needed")
        self.assertEqual(cs.group("GITHUB_WEBHOOK_SECRET"), "must match")

    def test_no_name_is_in_two_groups(self):
        self.assertFalse(set(cs.MUST_MATCH) & set(cs.MAY_BE_EMPTY))
        self.assertFalse((set(cs.MUST_MATCH) | set(cs.MAY_BE_EMPTY)) & set(cs.SWITCH))

    def test_every_name_it_knows_is_a_line_of_the_example(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.example")) as f:
            example = set(cs.parse_env(f.read()))
        for name in list(cs.MUST_MATCH) + list(cs.MAY_BE_EMPTY) + list(cs.SWITCH) + list(cs.EMPTY_MEANS) + list(cs.CHECKS):
            self.assertIn(name, example)


class CredentialKey(unittest.TestCase):
    def setUp(self):
        self.key = os.urandom(32)
        self.value = base64.b64encode(self.key).decode()
        self.stored = [app_ciphertext(self.key, "made-up-token-%d" % i) for i in range(3)]

    def test_the_right_key_opens_every_one(self):
        self.assertEqual(cs.credential_key_opens(self.value, self.stored), (3, 0))

    def test_a_line_break_does_not_matter(self):
        # Node's base64 decoding skips it, so the app reads the same key.
        self.assertEqual(cs.credential_key_opens(self.value + "\n", self.stored), (3, 0))

    def test_another_key_opens_none(self):
        other = base64.b64encode(os.urandom(32)).decode()
        self.assertEqual(cs.credential_key_opens(other, self.stored), (0, 3))

    def test_not_a_key(self):
        self.assertEqual(cs.credential_key_opens("not-base64-of-32-bytes", self.stored), (0, 3))

    def test_read_as_leniently_as_node(self):
        # Buffer.from(raw, 'base64') takes it without padding and in the URL-safe alphabet.
        bare = self.value.rstrip("=")
        self.assertEqual(cs.credential_key_opens(bare, self.stored), (3, 0))
        urlsafe = self.value.replace("+", "-").replace("/", "_")
        self.assertEqual(cs.credential_key_opens(urlsafe, self.stored), (3, 0))


class RunSkillSecret(unittest.TestCase):
    def test_as_entered(self):
        rows = [(USER, PHONE, phone_hash("made-up-secret", USER, PHONE, "004217"))]
        self.assertEqual(cs.phone_code_key_variant("made-up-secret", rows), "as entered")

    def test_stored_with_a_line_break(self):
        rows = [(USER, PHONE, phone_hash("made-up-secret\n", USER, PHONE, "999999"))]
        self.assertEqual(cs.phone_code_key_variant("made-up-secret", rows), "with a line break")

    def test_entered_with_one_it_should_not_have(self):
        rows = [(USER, PHONE, phone_hash("made-up-secret", USER, PHONE, "000000"))]
        self.assertEqual(cs.phone_code_key_variant("made-up-secret\n", rows), "without the line break")

    def test_another_secret(self):
        rows = [(USER, PHONE, phone_hash("made-up-secret", USER, PHONE, "123456"))]
        self.assertIsNone(cs.phone_code_key_variant("another-made-up-secret", rows))


class SigningKey(unittest.TestCase):
    def test_public_half(self):
        key = Ed25519PrivateKey.generate()
        value = base64.b64encode(key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())).decode()
        public = base64.b64encode(key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode()
        self.assertEqual(cs.signing_public_key(value), public)
        self.assertEqual(cs.signing_public_key(value + "\n"), public)

    def test_not_a_key(self):
        self.assertIsNone(cs.signing_public_key("bm90IGEga2V5"))


class Small(unittest.TestCase):
    def test_trunk_secrets(self):
        urls = ["sip:made-up.sip.example.com;transport=tls?X-NI-Trunk=abc123", "sip:x.example.com?X-Dial8-Trunk=DEF456", None, "sip:none.example.com"]
        self.assertEqual(cs.trunk_secrets(urls), {"abc123", "DEF456"})
        # Not only hex: the whole value, never a leading part of it.
        self.assertEqual(cs.trunk_secrets(["sip:x.example.com?X-NI-Trunk=3fa9Kq_zz%2B1&other=1"]), {"3fa9Kq_zz+1"})

    def test_sender_domain(self):
        self.assertEqual(cs.sender_domain("Made Up <hello@Example.dev>"), "example.dev")
        self.assertEqual(cs.sender_domain("hello@example.dev"), "example.dev")
        self.assertIsNone(cs.sender_domain("not an address"))


class Report(unittest.TestCase):
    def test_what_blocks_and_what_does_not(self):
        env = {
            "NI_LIVE": "",
            "CREDENTIAL_ENCRYPTION_KEY": "",
            "RUN_SKILL_INTERNAL_SECRET": "rehearsal-made-up",
            "STRIPE_SECRET_KEY": "made-up",
            "SENTRY_ORG": "",
            "SANDBOX_ACCESS_TOKEN": "made-up",
            "CRON_SECRET": "made-up",
        }
        results = {"STRIPE_SECRET_KEY": (True, "fine"), "SANDBOX_ACCESS_TOKEN": (False, "refused")}
        lines, blockers, unchecked = cs.report(env, results)
        self.assertEqual(blockers, [
            "CREDENTIAL_ENCRYPTION_KEY is empty",
            "RUN_SKILL_INTERNAL_SECRET holds a rehearsal's stand-in",
            "SANDBOX_ACCESS_TOKEN: refused",
        ])
        text = "\n".join(lines)
        self.assertIn("SENTRY_ORG", text)
        self.assertNotIn("made-up", text)
        self.assertEqual(unchecked, [])

    def test_a_proof_that_could_not_run_blocks(self):
        env = {"CREDENTIAL_ENCRYPTION_KEY": "made-up", "RUN_SKILL_INTERNAL_SECRET": "made-up", "EMAIL_FROM": "made-up"}
        results = {
            "CREDENTIAL_ENCRYPTION_KEY": (None, "could not be checked: ModuleNotFoundError"),
            "RUN_SKILL_INTERNAL_SECRET": ("nothing", "no stored phone code to check it against"),
            "EMAIL_FROM": (None, "the mail service did not list its domains (500)"),
        }
        _, blockers, unchecked = cs.report(env, results)
        self.assertEqual(blockers, ["CREDENTIAL_ENCRYPTION_KEY is unproven (could not be checked: ModuleNotFoundError)"])
        self.assertEqual(unchecked, ["EMAIL_FROM"])

    def test_names_only_run_shows_no_value(self):
        secret = "made-up-value-that-must-not-show"
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("NI_LIVE=\nCRON_SECRET=%s\nCREDENTIAL_ENCRYPTION_KEY=\nSENTRY_ORG=\n" % secret)
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cs.main(["check_settings.py", f.name, "--names-only"])
        finally:
            os.unlink(f.name)
        text = out.getvalue()
        self.assertNotIn(secret, text)
        self.assertIn("CREDENTIAL_ENCRYPTION_KEY is empty", text)
        self.assertIn("NOT MET (1)", text)


if __name__ == "__main__":
    unittest.main()
