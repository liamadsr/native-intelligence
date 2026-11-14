"""Tests for check_settings.py: python3 -m unittest discover -s deploy/app/tests

Every key, number and id here is made up. Needs the cryptography package (Ubuntu's
python3-cryptography, as on the server).
"""
import base64
import contextlib
import hmac
import io
import json
import os
import re
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

    def test_reads_an_exported_line_as_compose_does(self):
        self.assertEqual(cs.parse_env("export VERCEL_ENV=made-up\nexport\tA='b'\nexported=1\n"), {"VERCEL_ENV": "made-up", "A": "b", "exported": "1"})


class Groups(unittest.TestCase):
    def test_groups(self):
        self.assertEqual(cs.group("NI_LIVE"), "switch")
        self.assertEqual(cs.group("CREDENTIAL_ENCRYPTION_KEY"), "must match")
        self.assertEqual(cs.group("NEXT_PUBLIC_SITE_URL"), "may be empty")
        self.assertEqual(cs.group("SANDBOX_ACCESS_TOKEN"), "needed")
        # A new value is fine for it: only cloud browsers running at the switch hold tokens made with it.
        self.assertEqual(cs.group("BROWSER_INTERNAL_SECRET"), "needed")
        self.assertEqual(cs.group("GITHUB_WEBHOOK_SECRET"), "must match")
        # Slack: our own app's four settings, all four or none; empty is Slack off.
        for name in ("SLACK_APP_ID", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"):
            self.assertEqual(cs.group(name), "may be empty")
        # The connector's settings are gone.
        for name in ("CONNECT_ACCESS_TOKEN", "CONNECT_PROJECT_ID", "CONNECT_ENVIRONMENT", "CONNECT_TEAM_ID", "SLACK_CONNECTOR"):
            self.assertNotIn(name, cs.MAY_BE_EMPTY)
            self.assertNotIn(name, cs.EMPTY_MEANS)
            self.assertNotIn(name, cs.CHECKS)
        # Nothing on the server read these three: gone from the file and from here.
        for name in ("SENTRY_ORG", "SENTRY_PROJECT", "RUN_SKILL_LOCAL_DISPATCH_ENABLED"):
            self.assertNotIn(name, cs.MAY_BE_EMPTY)

    def test_no_name_is_in_two_groups(self):
        self.assertFalse(set(cs.MUST_MATCH) & set(cs.MAY_BE_EMPTY))
        self.assertFalse((set(cs.MUST_MATCH) | set(cs.MAY_BE_EMPTY)) & set(cs.SWITCH))

    def test_the_earlier_hosts_variables_are_in_no_other_group_and_not_in_the_example(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.example")) as f:
            example = set(cs.parse_env(f.read()))
        for name in cs.MUST_BE_ABSENT:
            self.assertEqual(cs.group(name), "must be absent")
            self.assertNotIn(name, example)
            for other in (cs.MUST_MATCH, cs.MAY_BE_EMPTY, cs.SWITCH, cs.EMPTY_MEANS, cs.CHECKS):
                self.assertNotIn(name, other)
        # The build's commit keeps the name the earlier host gave it: not one of them.
        self.assertEqual(cs.group("VERCEL_GIT_COMMIT_SHA"), "needed")

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


class FakeHttp:
    """Stands in for check_settings.http: answers by URL prefix, records each call."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, url, headers=None, auth=None, post=None, method=None):
        self.calls.append((url, headers, post, method))
        for prefix, answer in self.answers:
            if url.startswith(prefix):
                return answer
        raise AssertionError("unexpected request")

    def __enter__(self):
        self.real, cs.http = cs.http, self
        return self

    def __exit__(self, *_):
        cs.http = self.real


class Slack(unittest.TestCase):
    ENV = {"SLACK_APP_ID": "A0MADEUP01", "SLACK_CLIENT_ID": "1111111111.2222222222",
           "SLACK_CLIENT_SECRET": "c1" * 16, "SLACK_SIGNING_SECRET": "5e" * 16}
    NAMES = tuple(ENV)

    def run_check(self, name, env):
        with FakeHttp([]) as fake:
            result = cs.CHECKS[name](dict(env), {})
        self.assertEqual(fake.calls, [])  # nothing is asked of Slack
        return result

    def test_all_four_well_formed_are_quiet(self):
        for name in self.NAMES:
            self.assertEqual(self.run_check(name, self.ENV), (None, None))
        # Spaces around a value are what the app trims too.
        self.assertEqual(self.run_check("SLACK_CLIENT_SECRET", dict(self.ENV, SLACK_CLIENT_SECRET=" %s\n" % self.ENV["SLACK_CLIENT_SECRET"])), (None, None))

    def test_all_four_or_none(self):
        for missing in self.NAMES:
            env = dict(self.ENV, **{missing: ""})
            for name in self.NAMES:
                if name == missing:
                    continue
                ok, note = self.run_check(name, env)
                self.assertIs(ok, False, (missing, name))
                self.assertIn(missing, note)
                self.assertIn("all four or none", note)

    def test_the_client_secret_must_not_be_the_signing_secret(self):
        env = dict(self.ENV, SLACK_CLIENT_SECRET=self.ENV["SLACK_SIGNING_SECRET"])
        ok, note = self.run_check("SLACK_CLIENT_SECRET", env)
        self.assertIs(ok, False)
        self.assertIn("SLACK_SIGNING_SECRET", note)
        self.assertNotIn(self.ENV["SLACK_SIGNING_SECRET"], note)
        # Said once, on the client secret: the signing secret's own check stays quiet.
        self.assertEqual(self.run_check("SLACK_SIGNING_SECRET", env), (None, None))
        # Spaces around either value are trimmed first, as the app trims them.
        spaced = dict(env, SLACK_CLIENT_SECRET=" %s\n" % env["SLACK_CLIENT_SECRET"], SLACK_SIGNING_SECRET="%s " % env["SLACK_SIGNING_SECRET"])
        self.assertIs(self.run_check("SLACK_CLIENT_SECRET", spaced)[0], False)

    def test_secrets_of_32_to_128_hex_characters_either_case(self):
        for value in ("0123456789ABCDEF0123456789abcdef", "a" * 64, "F" * 128):
            for name in ("SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"):
                self.assertEqual(self.run_check(name, dict(self.ENV, **{name: value})), (None, None), (name, len(value)))
        for value in ("a" * 31, "a" * 129, "g" * 32):
            for name in ("SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"):
                self.assertIs(self.run_check(name, dict(self.ENV, **{name: value}))[0], False, (name, value[:3]))

    def test_the_same_shapes_as_the_app(self):
        # web/src/lib/slack/config.ts holds the same four rules: keep them identical.
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
                               "web", "src", "lib", "slack", "config.ts")) as f:
            config = f.read()
        self.assertIn("const APP_ID = /^A[A-Z0-9]{2,30}$/", config)
        self.assertIn("const CLIENT_ID = /^[0-9]{3,20}\\.[0-9]{3,20}$/", config)
        self.assertIn("const SECRET = /^[0-9a-f]{32,128}$/i", config)
        self.assertEqual(cs.SLACK_SETTINGS["SLACK_APP_ID"][0], r"A[A-Z0-9]{2,30}")
        self.assertEqual(cs.SLACK_SETTINGS["SLACK_CLIENT_ID"][0], r"[0-9]{3,20}\.[0-9]{3,20}")
        self.assertEqual(cs.SLACK_SETTINGS["SLACK_CLIENT_SECRET"][0], r"[0-9a-fA-F]{32,128}")
        self.assertEqual(cs.SLACK_SETTINGS["SLACK_SIGNING_SECRET"][0], r"[0-9a-fA-F]{32,128}")

    def test_a_malformed_one_is_wrong_and_never_shown(self):
        bad = {"SLACK_APP_ID": "T0NOTANAPP", "SLACK_CLIENT_ID": "made-up-client", "SLACK_CLIENT_SECRET": "made-up-secret-value",
               "SLACK_SIGNING_SECRET": "5e" * 15 + "5g"}
        for name, value in bad.items():
            ok, note = self.run_check(name, dict(self.ENV, **{name: value}))
            self.assertIs(ok, False, name)
            self.assertNotIn(value, note)

    def test_empty_says_slack_is_off_and_blocks_nothing(self):
        lines, blockers, _ = cs.report({name: "" for name in self.NAMES}, {})
        self.assertEqual(blockers, [])
        text = "\n".join(lines)
        for name in self.NAMES:
            self.assertIn(name, text)
        self.assertIn("Slack is off", text)

    def test_one_set_alone_blocks_the_gate(self):
        env = {name: "" for name in self.NAMES}
        env["SLACK_CLIENT_SECRET"] = self.ENV["SLACK_CLIENT_SECRET"]
        results = {"SLACK_CLIENT_SECRET": cs.CHECKS["SLACK_CLIENT_SECRET"](env, {})}
        _, blockers, _ = cs.report(env, results)
        self.assertEqual(len(blockers), 1)
        self.assertIn("SLACK_CLIENT_SECRET", blockers[0])
        self.assertNotIn(self.ENV["SLACK_CLIENT_SECRET"], blockers[0])


class Sandbox(unittest.TestCase):
    ENV = {"SANDBOX_ACCESS_TOKEN": "made-up", "SANDBOX_TEAM_ID": "team_madeup0001", "SANDBOX_PROJECT_ID": "prj_madeup0001"}

    def test_asks_the_api_address(self):
        with FakeHttp([("https://api.vercel.com/v2/sandboxes?", (200, {"sandboxes": []}))]) as fake:
            self.assertIs(cs.check_sandbox(self.ENV, {})[0], True)
        self.assertEqual(fake.calls[0][0], "https://api.vercel.com/v2/sandboxes?limit=1&project=prj_madeup0001&teamId=team_madeup0001")

    def test_answers(self):
        for status, want in ((401, False), (403, False), (0, None), (429, None), (503, None)):
            with FakeHttp([("https://api.vercel.com/", (status, None))]):
                self.assertIs(cs.check_sandbox(self.ENV, {})[0], want, status)


class LiveKit(unittest.TestCase):
    KEY = "APImadeup00001"
    SECRET = "made-up-secret-made-up-secret-made-up-secret-00"
    ENV = {"LIVEKIT_URL": "wss://livekit.example.dev", "LIVEKIT_API_KEY": KEY, "LIVEKIT_API_SECRET": SECRET}
    API = "https://livekit.example.dev/twirp/livekit.RoomService/ListRooms"

    def decode(self, token):
        def part(p):
            return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        header, body, signature = token.split(".")
        expected = base64.urlsafe_b64encode(hmac.digest(self.SECRET.encode(), ("%s.%s" % (header, body)).encode(), "sha256")).rstrip(b"=").decode()
        self.assertEqual(signature, expected)
        return part(header), part(body)

    def test_the_token_is_one_livekit_reads(self):
        header, claims = self.decode(cs.livekit_token(self.KEY, self.SECRET, 1_800_000_000))
        self.assertEqual(header, {"alg": "HS256", "typ": "JWT"})
        # The key is the issuer; the grant allows listing rooms and nothing else.
        self.assertEqual(claims, {"iss": self.KEY, "nbf": 1_799_999_990, "exp": 1_800_000_300, "video": {"roomList": True}})

    def test_the_address(self):
        self.assertEqual(cs.livekit_api_base("wss://livekit.example.dev"), "https://livekit.example.dev")
        self.assertEqual(cs.livekit_api_base(" wss://livekit.example.dev/\n"), "https://livekit.example.dev")
        self.assertEqual(cs.livekit_api_base("wss://livekit.example.dev:8443"), "https://livekit.example.dev:8443")
        for wrong in ("ws://livekit.example.dev", "https://livekit.example.dev", "wss://livekit.example.dev/rtc", "livekit.example.dev", ""):
            self.assertIsNone(cs.livekit_api_base(wrong), wrong)

    def test_one_call_to_the_server_api(self):
        with FakeHttp([(self.API, (200, {"rooms": [{"name": "a"}]}))]) as fake:
            ok, note = cs.check_livekit(dict(self.ENV), {})
        self.assertIs(ok, True)
        self.assertIn("1 room open", note)
        self.assertEqual(len(fake.calls), 1)
        url, headers, post, _ = fake.calls[0]
        self.assertEqual(url, self.API)
        self.assertEqual(post, {})
        _, claims = self.decode(headers["Authorization"].split(" ", 1)[1])
        self.assertEqual(claims["iss"], self.KEY)
        self.assertNotIn(self.SECRET, note)

    def test_answers(self):
        for answer, want, words in (((200, {}), True, "0 rooms"), ((401, None), False, "refused"), ((404, None), False, "answered 404"),
                                    ((0, None), None, "cannot tell"), ((429, None), None, "cannot tell"), ((502, None), None, "cannot tell")):
            with FakeHttp([(self.API, answer)]):
                ok, note = cs.check_livekit(dict(self.ENV), {})
            self.assertIs(ok, want, answer)
            self.assertIn(words, note)

    def test_wrong_before_asking(self):
        with FakeHttp([]) as fake:
            self.assertIs(cs.check_livekit(dict(self.ENV, LIVEKIT_URL="ws://livekit.example.dev"), {})[0], False)
            self.assertIs(cs.check_livekit(dict(self.ENV, LIVEKIT_API_SECRET=" "), {})[0], False)
            self.assertIs(cs.check_livekit({"LIVEKIT_URL": "wss://livekit.example.dev"}, {})[0], False)
        self.assertEqual(fake.calls, [])

    def test_all_three_or_none(self):
        self.assertEqual(cs.group("LIVEKIT_URL"), "may be empty")
        self.assertEqual(cs.group("LIVEKIT_API_SECRET"), "may be empty")
        ok, note = cs.CHECKS["LIVEKIT_API_SECRET"]({"LIVEKIT_URL": "", "LIVEKIT_API_SECRET": self.SECRET}, {})
        self.assertIs(ok, False)
        self.assertIn("LIVEKIT_URL", note)
        self.assertEqual(cs.CHECKS["LIVEKIT_API_KEY"](dict(self.ENV), {}), (None, None))
        # Empty, all three: calls are off, and that blocks nothing.
        _, blockers, _ = cs.report({"LIVEKIT_URL": "", "LIVEKIT_API_KEY": "", "LIVEKIT_API_SECRET": ""}, {})
        self.assertEqual(blockers, [])
        # Set, and refused by the server: that blocks.
        _, blockers, _ = cs.report(dict(self.ENV), {"LIVEKIT_URL": (False, "refused")})
        self.assertEqual(blockers, ["LIVEKIT_URL: refused"])

    def test_the_egress_switch(self):
        self.assertEqual(cs.group("LIVEKIT_EGRESS"), "may be empty")
        check = cs.CHECKS["LIVEKIT_EGRESS"]
        self.assertEqual(check(dict(self.ENV, LIVEKIT_EGRESS="on"), {}), (None, None))
        self.assertEqual(check(dict(self.ENV, LIVEKIT_EGRESS="on\n"), {}), (None, None))
        for wrong in ("1", "true", "ON", "yes"):
            ok, note = check(dict(self.ENV, LIVEKIT_EGRESS=wrong), {})
            self.assertIs(ok, False, wrong)
            self.assertIn("only on", note)
        ok, note = check({"LIVEKIT_URL": "", "LIVEKIT_EGRESS": "on"}, {})
        self.assertIs(ok, False)
        self.assertIn("LIVEKIT_URL", note)
        # Empty is off and blocks nothing; a wrong value blocks.
        _, blockers, _ = cs.report({"LIVEKIT_EGRESS": ""}, {})
        self.assertEqual(blockers, [])
        _, blockers, _ = cs.report({"LIVEKIT_EGRESS": "1"}, {"LIVEKIT_EGRESS": check({"LIVEKIT_EGRESS": "1"}, {})})
        self.assertEqual(len(blockers), 1)


class OwnRuntime(unittest.TestCase):
    """The coding agent's own sandbox runtime: a group of its own, and the git gate's addresses."""

    KEY = "e2b_" + "0123456789abcdef" * 2 + "ab"
    ENV = {
        "SANDBOX_RUNTIME_API_URL": "http://10.200.77.2:3000",
        "SANDBOX_RUNTIME_TRAFFIC_URL": "http://10.200.77.2:3002",
        "SANDBOX_RUNTIME_KEY": KEY,
        "SANDBOX_RUNTIME_TEMPLATE": "",
        "AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES": "203.0.113.7, 2001:db8::7",
        "SANDBOX_ACCESS_TOKEN": "",
        "SANDBOX_TEAM_ID": "",
        "SANDBOX_PROJECT_ID": "",
    }
    API = "http://10.200.77.2:3000"

    def check(self, env, answers=()):
        with FakeHttp(list(answers)) as fake:
            ok, note = cs.CHECKS["SANDBOX_RUNTIME_API_URL"](env, {})
        self.assertNotIn(self.KEY, note)
        return ok, note, fake.calls

    def test_may_be_empty_all_of_them(self):
        for name in ("SANDBOX_RUNTIME_API_URL", "SANDBOX_RUNTIME_TRAFFIC_URL", "SANDBOX_RUNTIME_KEY", "SANDBOX_RUNTIME_TEMPLATE",
                     "AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES"):
            self.assertEqual(cs.group(name), "may be empty", name)
        _, blockers, _ = cs.report({n: "" for n in self.ENV}, {})
        self.assertEqual([b for b in blockers if "RUNTIME" in b or "GATE" in b], [])

    IMAGES = [{"aliases": ["base"]}, {"aliases": ["ni-coding-agent"]}]

    def test_proven_by_health_a_listing_with_the_key_and_the_image(self):
        ok, note, calls = self.check(dict(self.ENV), [(self.API + "/health", (200, None)), (self.API + "/sandboxes", (200, [])),
                                                      (self.API + "/templates", (200, self.IMAGES))])
        self.assertIs(ok, True)
        self.assertEqual([c[0] for c in calls], [self.API + "/health", self.API + "/sandboxes", self.API + "/templates"])
        self.assertEqual(calls[1][1], {"X-API-Key": self.KEY})
        self.assertEqual(calls[2][1], {"X-API-Key": self.KEY})
        self.assertIsNone(calls[0][1])

    def test_the_image_must_be_on_the_runtime(self):
        up = [(self.API + "/health", (200, None)), (self.API + "/sandboxes", (200, []))]
        # Not built yet: every run would fail at its first step, with everything else in order.
        ok, note, _ = self.check(dict(self.ENV), up + [(self.API + "/templates", (200, [{"aliases": ["base"]}]))])
        self.assertIs(ok, False)
        self.assertIn("no image", note)
        # Another name asked for, which the runtime has: fine. The name itself is never shown.
        ok, note, _ = self.check(dict(self.ENV, SANDBOX_RUNTIME_TEMPLATE="base"), up + [(self.API + "/templates", (200, self.IMAGES))])
        self.assertIs(ok, True)
        ok, note, _ = self.check(dict(self.ENV, SANDBOX_RUNTIME_TEMPLATE="made-up-name"), up + [(self.API + "/templates", (200, self.IMAGES))])
        self.assertIs(ok, False)
        self.assertNotIn("made-up-name", note)
        # The listing could not be had: cannot tell, never "all good".
        for answer, want in (((503, None), None), ((0, None), None), ((404, None), False), ((200, {"not": "a list"}), False)):
            ok, _, _ = self.check(dict(self.ENV), up + [(self.API + "/templates", answer)])
            self.assertIs(ok, want, answer)

    def test_the_gate_addresses_must_be_public_ones(self):
        self.assertEqual(cs.gate_addresses_not_public("203.0.113.7, 2001:db8::7"), 0)
        self.assertEqual(cs.gate_addresses_not_public("10.200.77.2 127.0.0.1 ::1 fe80::1%eth0 192.168.1.4 100.64.0.9 fd00::2 0.0.0.0 [::ffff:10.0.0.1] 172.20.0.3"), 10)
        # The likely mistake: the tunnel's address, from the lines above it in .env.
        ok, note, calls = self.check(dict(self.ENV, AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES="10.200.77.2"))
        self.assertIs(ok, False)
        self.assertIn("PUBLIC", note)
        self.assertNotIn("10.200.77.2", note)
        self.assertEqual(calls, [])
        ok, note = cs.CHECKS["AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES"](dict(self.ENV, AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES="203.0.113.7 10.200.77.2"), {})
        self.assertIs(ok, False)
        self.assertNotIn("10.200.77.2", note)

    def test_answers(self):
        for health, listing, want in (((200, None), (401, None), False), ((200, None), (403, None), False), ((0, None), None, None),
                                      ((503, None), None, None), ((404, None), None, False), ((200, None), (502, None), None)):
            answers = [(self.API + "/health", health)] + ([(self.API + "/sandboxes", listing)] if listing else [])
            ok, _, _ = self.check(dict(self.ENV), answers)
            self.assertIs(ok, want, (health, listing))

    def test_all_three_or_none(self):
        for name in ("SANDBOX_RUNTIME_TRAFFIC_URL", "SANDBOX_RUNTIME_KEY"):
            ok, note, calls = self.check(dict(self.ENV, **{name: " "}))
            self.assertIs(ok, False)
            self.assertIn(name, note)
            self.assertEqual(calls, [])
            # And the other way round: one of them set without the API URL.
            ok, note = cs.CHECKS[name](dict(self.ENV, SANDBOX_RUNTIME_API_URL=""), {})
            self.assertIs(ok, False)
            self.assertIn("SANDBOX_RUNTIME_API_URL", note)
            self.assertEqual(cs.CHECKS[name](dict(self.ENV), {}), (None, None))

    def test_the_urls_are_the_tunnel(self):
        self.assertIsNone(cs.runtime_url_problem("http://10.200.77.2:3000"))
        self.assertIsNone(cs.runtime_url_problem(" http://10.200.77.2:3002/\n"))
        self.assertIsNone(cs.runtime_url_problem("http://[fd00::2]:3000"))
        for wrong in ("https://10.200.77.2:3000", "http://203.0.113.7:3000", "http://sandbox.example.com:3000",
                      "http://10.200.77.2:3000/api", "10.200.77.2:3000", "http://u:p@10.200.77.2:3000", ""):
            self.assertIsNotNone(cs.runtime_url_problem(wrong), wrong)
            ok, note, calls = self.check(dict(self.ENV, SANDBOX_RUNTIME_API_URL=wrong or "x"))
            self.assertIs(ok, False, wrong)
            self.assertEqual(calls, [])
        ok, note = cs.CHECKS["SANDBOX_RUNTIME_TRAFFIC_URL"](dict(self.ENV, SANDBOX_RUNTIME_TRAFFIC_URL="https://10.200.77.2:3002"), {})
        self.assertIs(ok, False)

    def test_the_key_shape_never_shown(self):
        for wrong in ("e2b_" + "0" * 31, "e2b_" + "g" * 40, "sk_" + "0" * 40, "0" * 40):
            ok, note, calls = self.check(dict(self.ENV, SANDBOX_RUNTIME_KEY=wrong))
            self.assertIs(ok, False, wrong)
            self.assertNotIn(wrong, note)
            self.assertEqual(calls, [])
            ok, note = cs.CHECKS["SANDBOX_RUNTIME_KEY"](dict(self.ENV, SANDBOX_RUNTIME_KEY=wrong), {})
            self.assertIs(ok, False)
            self.assertNotIn(wrong, note)
        self.assertTrue(cs.runtime_key_shape_ok(" %s\n" % self.KEY))

    def test_needs_the_gate_addresses(self):
        ok, note, calls = self.check(dict(self.ENV, AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES=""))
        self.assertIs(ok, False)
        self.assertIn("AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES", note)
        self.assertEqual(calls, [])
        ok, note, _ = self.check(dict(self.ENV, AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES="203.0.113.7, sandbox.example.com"))
        self.assertIs(ok, False)
        self.assertNotIn("sandbox.example.com", note)

    def test_the_hosted_three_may_stay_beside_it_for_the_cloud_browser(self):
        hosted = {"SANDBOX_ACCESS_TOKEN": "made-up", "SANDBOX_TEAM_ID": "team_madeup0001", "SANDBOX_PROJECT_ID": "prj_madeup0001"}
        both = dict(self.ENV, **hosted)
        ok, note, calls = self.check(both, [(self.API + "/health", (200, None)), (self.API + "/sandboxes", (200, [])),
                                            (self.API + "/templates", (200, self.IMAGES))])
        self.assertIs(ok, True)
        self.assertNotIn("made-up", note)
        self.assertEqual(len(calls), 3)
        # The hosted three keep their own check, unchanged, against the hosted service.
        with FakeHttp([("https://api.vercel.com/v2/sandboxes?", (200, {"sandboxes": []}))]) as fake:
            self.assertIs(cs.check_sandbox(both, {})[0], True)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(cs.group("SANDBOX_ACCESS_TOKEN"), "needed")
        # Empty, it still blocks Gate 1 (the cloud browser needs it), and says what is off in both worlds.
        _, blockers, _ = cs.report(dict(self.ENV, SANDBOX_ACCESS_TOKEN=""), {})
        self.assertIn("SANDBOX_ACCESS_TOKEN is empty", blockers)
        self.assertIn("cloud browser", cs.EMPTY_MEANS["SANDBOX_ACCESS_TOKEN"])
        self.assertIn("unless our own sandbox runtime is set", cs.EMPTY_MEANS["SANDBOX_ACCESS_TOKEN"])

    def test_the_gate_addresses_alone(self):
        check = cs.CHECKS["AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES"]
        self.assertEqual(cs.gate_address_problems("203.0.113.7,2001:db8::7 [2001:db8::8] fe80::1%eth0"), (0, 4))
        self.assertEqual(cs.gate_address_problems("203.0.113.7 nope 198.51.100.300"), (2, 1))
        self.assertEqual(check(dict(self.ENV), {}), (None, None))
        ok, note = check(dict(self.ENV, AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES="203.0.113.7 secret-ish-entry"), {})
        self.assertIs(ok, False)
        self.assertNotIn("secret-ish-entry", note)
        # Set without the runtime: said, and blocks nothing.
        lone = {"AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES": "203.0.113.7", "SANDBOX_RUNTIME_API_URL": ""}
        result = check(lone, {})
        self.assertEqual(result[0], "warn")
        self.assertIn("refuse every clone and push from the hosted sandbox service's sandboxes", result[1])
        lines, blockers, unchecked = cs.report(lone, {"AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES": result})
        self.assertEqual((blockers, unchecked), ([], []))
        self.assertIn("WARNING", "\n".join(lines))
        self.assertNotIn("203.0.113.7", "\n".join(lines))

    def test_the_template(self):
        check = cs.CHECKS["SANDBOX_RUNTIME_TEMPLATE"]
        self.assertEqual(check(dict(self.ENV, SANDBOX_RUNTIME_TEMPLATE="ni-coding-agent"), {}), (None, None))
        self.assertIs(check(dict(self.ENV, SANDBOX_RUNTIME_TEMPLATE="Not A Name"), {})[0], False)
        self.assertEqual(check({"SANDBOX_RUNTIME_TEMPLATE": "ni-coding-agent"}, {})[0], "warn")

    def test_a_names_only_run_shows_no_value(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.writelines("%s=%s\n" % kv for kv in self.ENV.items())
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cs.main(["check_settings.py", f.name, "--names-only"])
        finally:
            os.unlink(f.name)
        text = out.getvalue()
        for value in (self.KEY, "10.200.77.2", "203.0.113.7"):
            self.assertNotIn(value, text)


class CallRecorder(unittest.TestCase):
    ENV = {"LIVEKIT_URL": "wss://livekit.example.dev", "CAPTURE_FEED_SECRET": "f" * 48, "RUN_SKILL_INTERNAL_SECRET": "r" * 48}

    def test_the_switch(self):
        self.assertEqual(cs.group("TEAM_CALL_RECORDER"), "may be empty")
        check = cs.CHECKS["TEAM_CALL_RECORDER"]
        self.assertEqual(check(dict(self.ENV, TEAM_CALL_RECORDER="on"), {}), (None, None))
        for wrong in ("1", "true", "ON"):
            ok, note = check(dict(self.ENV, TEAM_CALL_RECORDER=wrong), {})
            self.assertIs(ok, False, wrong)
            self.assertIn("only on", note)
        ok, note = check(dict(self.ENV, LIVEKIT_URL="", TEAM_CALL_RECORDER="on"), {})
        self.assertIs(ok, False)
        self.assertIn("LIVEKIT_URL", note)
        ok, note = check(dict(self.ENV, CAPTURE_FEED_SECRET="", TEAM_CALL_RECORDER="on"), {})
        self.assertIs(ok, False)
        self.assertIn("CAPTURE_FEED_SECRET", note)
        _, blockers, _ = cs.report({"TEAM_CALL_RECORDER": "", "CAPTURE_FEED_SECRET": ""}, {})
        self.assertEqual(blockers, [])

    def test_the_switches_that_need_the_recorder(self):
        # Phase 2's two, and phase 4's audio files.
        for name in ("TEAM_CALL_LIVE_AGENT", "TEAM_CALL_EVENT_LINK", "TEAM_CALL_AUDIO"):
            self.assertEqual(cs.group(name), "may be empty")
            check = cs.CHECKS[name]
            self.assertEqual(check(dict(self.ENV, TEAM_CALL_RECORDER="on", **{name: "on"}), {}), (None, None))
            # As the app reads it: trimmed, any case.
            self.assertEqual(check(dict(self.ENV, TEAM_CALL_RECORDER="on", **{name: " ON "}), {}), (None, None))
            for wrong in ("1", "true", "yes"):
                ok, note = check(dict(self.ENV, TEAM_CALL_RECORDER="on", **{name: wrong}), {})
                self.assertIs(ok, False, wrong)
                self.assertIn("only on", note)
            ok, note = check(dict(self.ENV, TEAM_CALL_RECORDER="", **{name: "on"}), {})
            self.assertIs(ok, False)
            self.assertIn("TEAM_CALL_RECORDER", note)
            _, blockers, _ = cs.report({name: ""}, {})
            self.assertEqual(blockers, [])

    def test_the_secret_is_its_own(self):
        self.assertEqual(cs.group("CAPTURE_FEED_SECRET"), "may be empty")
        check = cs.CHECKS["CAPTURE_FEED_SECRET"]
        self.assertEqual(check(dict(self.ENV), {}), (None, None))
        ok, note = check(dict(self.ENV, CAPTURE_FEED_SECRET="short"), {})
        self.assertIs(ok, False)
        self.assertIn("at least 32", note)
        ok, note = check(dict(self.ENV, CAPTURE_FEED_SECRET="r" * 48), {})
        self.assertIs(ok, False)
        self.assertIn("RUN_SKILL_INTERNAL_SECRET", note)
        self.assertNotIn("r" * 48, note)


class Report(unittest.TestCase):
    def test_what_blocks_and_what_does_not(self):
        env = {
            "NI_LIVE": "",
            "CREDENTIAL_ENCRYPTION_KEY": "",
            "RUN_SKILL_INTERNAL_SECRET": "rehearsal-made-up",
            "STRIPE_SECRET_KEY": "made-up",
            "NEXT_PUBLIC_SITE_URL": "",
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
        self.assertIn("NEXT_PUBLIC_SITE_URL", text)
        self.assertNotIn("made-up", text)
        self.assertEqual(unchecked, [])

    def test_the_earlier_hosts_variables_block_when_set(self):
        env = {"CRON_SECRET": "made-up", "VERCEL": "1", "VERCEL_ENV": "made-up-env", "VERCEL_TARGET_ENV": "",
               "VERCEL_PROJECT_ID": "rehearsal-made-up", "VERCEL_OIDC_TOKEN": "made-up", "VERCEL_GIT_COMMIT_SHA": "made-up"}
        lines, blockers, unchecked = cs.report(env, {})
        self.assertEqual(blockers, [
            "%s is set: no container starts with it (entrypoint.sh); remove the line" % n
            for n in ("VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN")
        ])
        text = "\n".join(lines)
        self.assertIn("Must not be here (the earlier host's own):", text)
        self.assertRegex(text, r"VERCEL_TARGET_ENV +empty +harmless")
        self.assertRegex(text, r"VERCEL_ENV +SET +remove the line")
        self.assertNotIn("made-up", text)
        # Each is said once, under its own heading, and never counted as a needed setting.
        self.assertEqual(len(re.findall(r"^   VERCEL_ENV ", text, re.M)), 1)
        self.assertEqual(unchecked, [])

    def test_no_heading_for_them_when_none_is_there(self):
        lines, blockers, _ = cs.report({"CRON_SECRET": "made-up"}, {})
        self.assertNotIn("Must not be here", "\n".join(lines))
        self.assertEqual(blockers, [])

    def test_a_names_only_run_reports_them_without_a_value(self):
        secret = "made-up-value-that-must-not-show"
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("CRON_SECRET=made-up\nVERCEL=\"1\"\nVERCEL_ENV=\"%s\"\n" % secret)
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cs.main(["check_settings.py", f.name, "--names-only"])
        finally:
            os.unlink(f.name)
        text = out.getvalue()
        self.assertNotIn(secret, text)
        self.assertIn("NOT MET (2)", text)
        self.assertIn("VERCEL_ENV is set", text)

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
            f.write("NI_LIVE=\nCRON_SECRET=%s\nCREDENTIAL_ENCRYPTION_KEY=\nNEXT_PUBLIC_SITE_URL=\n" % secret)
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
