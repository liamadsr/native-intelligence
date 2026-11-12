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
        # Slack stays on: an empty token or project id blocks the gate, the environment defaults.
        self.assertEqual(cs.group("CONNECT_ACCESS_TOKEN"), "needed")
        self.assertEqual(cs.group("CONNECT_PROJECT_ID"), "needed")
        self.assertEqual(cs.group("CONNECT_ENVIRONMENT"), "may be empty")
        self.assertEqual(cs.group("CONNECT_TEAM_ID"), "may be empty")

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


class Connectors(unittest.TestCase):
    PROJECT = "prj_madeup0001"
    PROJECT_TOKEN = "made-up.project.token"
    SLACK_TOKEN = "made-up-slack-bot-token"
    ENV = {"CONNECT_ACCESS_TOKEN": " made-up-access-token\n", "SLACK_CONNECTOR": "slack/made-up",
           "CONNECT_PROJECT_ID": PROJECT, "CONNECT_TEAM_ID": "team_madeup0001", "SANDBOX_TEAM_ID": "team_madeup0002"}
    MINT = "https://api.vercel.com/v1/projects/"
    META = "https://api.vercel.com/v1/connect/connectors/"
    TOKEN = "https://api.vercel.com/v1/connect/token/"
    SLACK = "https://slack.com/api/auth.test"

    def answers(self, **over):
        a = {
            "mint": (200, {"token": self.PROJECT_TOKEN}),
            "meta": (200, {"uid": "slack/made-up", "defaultInstallationId": "T0MADEUP1",
                           "triggerDestinations": [{"projectId": "prj_madeup0002", "path": "/api/slack/events"},
                                                   {"projectId": self.PROJECT, "path": "/api/slack/events"}]}),
            "token": (200, {"token": self.SLACK_TOKEN, "expiresAt": 1}),
            "slack": (200, {"ok": True, "team_id": "T0MADEUP1"}),
        }
        a.update(over)
        return [(self.MINT, a["mint"]), (self.META, a["meta"]), (self.TOKEN, a["token"]), (self.SLACK, a["slack"])]

    def run_check(self, env=None, **over):
        with FakeHttp(self.answers(**over)) as fake:
            ok, note = cs.check_connect(dict(env or self.ENV), {})
        for secret in ("made-up-access-token", self.PROJECT_TOKEN, self.SLACK_TOKEN):
            self.assertNotIn(secret, note or "")
        return ok, note, fake.calls

    def test_the_whole_path(self):
        ok, _, calls = self.run_check()
        self.assertIs(ok, True)
        self.assertEqual([c[0] for c in calls], [
            "https://api.vercel.com/v1/projects/prj_madeup0001/token?source=vercel-oidc-refresh&teamId=team_madeup0001",
            "https://api.vercel.com/v1/connect/connectors/slack%2Fmade-up",
            "https://api.vercel.com/v1/connect/token/slack%2Fmade-up",
            "https://slack.com/api/auth.test",
        ])
        # The access token only makes the project token; the project token does the rest.
        # As the app sends it: a POST with no body.
        self.assertEqual(calls[0][1], {"Authorization": "Bearer made-up-access-token"})
        self.assertEqual(calls[0][2:], (None, "POST"))
        self.assertEqual(calls[1][1], {"Authorization": "Bearer " + self.PROJECT_TOKEN})
        self.assertEqual(calls[1][2], None)
        self.assertEqual(calls[2][1], {"Authorization": "Bearer " + self.PROJECT_TOKEN})
        self.assertEqual(calls[2][2], {"subject": {"type": "app"}, "installationId": "T0MADEUP1", "scopes": ["*"]})
        self.assertEqual(calls[3][1], {"Authorization": "Bearer " + self.SLACK_TOKEN})

    def test_no_team_is_named_without_connect_team_id(self):
        # As the app: SANDBOX_TEAM_ID is never used in its place.
        env = dict(self.ENV, CONNECT_TEAM_ID="")
        _, _, calls = self.run_check(env)
        self.assertEqual(calls[0][0], "https://api.vercel.com/v1/projects/prj_madeup0001/token?source=vercel-oidc-refresh")

    def test_each_step_says_where_it_stopped(self):
        cases = [
            ({"mint": (403, None)}, False, "step 1"),
            ({"mint": (200, {"nothing": 1})}, False, "step 1"),
            ({"meta": (403, None)}, False, "step 2"),
            ({"meta": (200, {"defaultInstallationId": "T0MADEUP1", "triggerDestinations": [{"projectId": self.PROJECT, "path": "/api/other"}]})}, False, "step 2"),
            ({"meta": (200, {"defaultInstallationId": "T0MADEUP1", "triggerDestinations": [self.PROJECT]})}, None, "step 2"),
            ({"meta": (200, {"triggerDestinations": [{"projectId": self.PROJECT, "path": "/api/slack/events"}]})}, None, "step 2"),
            ({"token": (403, {"error": {"code": "forbidden"}})}, False, "step 3"),
            ({"slack": (200, {"ok": False, "error": "invalid_auth"})}, False, "invalid_auth"),
            ({"slack": (200, {"ok": True, "team_id": "T0OTHER01"})}, False, "another team"),
        ]
        for over, want, where in cases:
            ok, note, _ = self.run_check(**over)
            self.assertIs(ok, want, over)
            self.assertIn(where, note)

    def test_trouble_on_the_way_cannot_tell(self):
        for step in ("mint", "meta", "token", "slack"):
            for status in (0, 429, 502):
                ok, note, _ = self.run_check(**{step: (status, None)})
                self.assertIsNone(ok, (step, status))
                self.assertIn("cannot tell", note)

    def test_it_stops_at_the_first_failure(self):
        _, _, calls = self.run_check(mint=(401, None))
        self.assertEqual(len(calls), 1)

    def test_whitespace_or_a_missing_setting_never_asks(self):
        with FakeHttp([]) as fake:
            ok, note = cs.check_connect(dict(self.ENV, CONNECT_ACCESS_TOKEN="  \n"), {})
            self.assertIs(ok, False)
            self.assertIn("whitespace", note)
            ok, note = cs.check_connect(dict(self.ENV, CONNECT_PROJECT_ID=""), {})
            self.assertIs(ok, False)
            self.assertIn("CONNECT_PROJECT_ID", note)
        self.assertEqual(fake.calls, [])

    def test_a_wildcard_is_wrong(self):
        for name in ("CONNECT_PROJECT_ID", "CONNECT_ENVIRONMENT"):
            ok, note = cs.CHECKS[name]({name: "*"}, {})
            self.assertIs(ok, False)
            self.assertIn("refuses every event", note)
            self.assertEqual(cs.CHECKS[name]({name: "prj_madeup0001"}, {}), (None, None))
        _, blockers, _ = cs.report({"CONNECT_ENVIRONMENT": "pro*"}, {"CONNECT_ENVIRONMENT": cs.CHECKS["CONNECT_ENVIRONMENT"]({"CONNECT_ENVIRONMENT": "pro*"}, {})})
        self.assertEqual(len(blockers), 1)


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

    def test_proven_by_health_and_a_listing_with_the_key(self):
        ok, note, calls = self.check(dict(self.ENV), [(self.API + "/health", (200, None)), (self.API + "/sandboxes", (200, []))])
        self.assertIs(ok, True)
        self.assertEqual([c[0] for c in calls], [self.API + "/health", self.API + "/sandboxes"])
        self.assertEqual(calls[1][1], {"X-API-Key": self.KEY})
        self.assertIsNone(calls[0][1])

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
        ok, note, calls = self.check(both, [(self.API + "/health", (200, None)), (self.API + "/sandboxes", (200, []))])
        self.assertIs(ok, True)
        self.assertNotIn("made-up", note)
        self.assertEqual(len(calls), 2)
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
