"""Tests for the sealed copy: web/scripts/seal-settings.mjs seals in Node, and
deploy/app/sealed_settings.py opens on the server. Run with
python3 -m unittest discover -s deploy/app/tests (needs node and the cryptography package).

Every key and value here is made up.
"""
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
ROOT = APP.parent.parent
SEAL = ROOT / "web" / "scripts" / "seal-settings.mjs"
ENVFILE = ROOT / "deploy" / "supabase" / "envfile.py"
sys.path.insert(0, str(APP))
import sealed_settings as ss  # noqa: E402

SECRET = {
    # Made up, and built here so that it does not look like a key in the source.
    "CREDENTIAL_ENCRYPTION_KEY": __import__("base64").b64encode(b"made-up " * 4).decode(),
    "RUN_SKILL_INTERNAL_SECRET": "made-up-root-secret\n",  # stored with a line break, kept
    "EMAIL_FROM": "Made Up <hello@example.dev>",
    "TWILIO_PHONE_NUMBER": "+15555550101",
}


def node(script, env=None):
    e = {"PATH": os.environ["PATH"], "SEAL": SEAL.as_uri()}
    e.update(env or {})
    return subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, env=e, cwd=str(ROOT))


def seal(values, public, meta=None):
    r = node(
        "const m = await import(process.env.SEAL); const i = JSON.parse(process.env.INPUT);"
        "process.stdout.write(m.sealBlock(i.values, i.pub, i.meta).block)",
        {"INPUT": json.dumps({"values": values, "pub": public, "meta": meta if meta is not None else {"env": "production"}})},
    )
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return r.stdout


class Names(unittest.TestCase):
    def test_the_two_lists_are_the_same(self):
        js = SEAL.read_text()
        listed = re.search(r"export const NAMES = \[(.*?)\]", js, re.S).group(1)
        self.assertEqual(re.findall(r"'([A-Z0-9_]+)'", listed), ss.NAMES)

    def test_every_name_is_a_line_of_the_example(self):
        example = ss.parse_env((APP / ".env.example").read_text())
        for name in ss.NAMES:
            self.assertIn(name, example)

    def test_the_servers_own_keys_are_not_copied(self):
        for name in ("AI_GATEWAY_API_KEY", "INNGEST_SIGNING_KEY", "INNGEST_EVENT_KEY", "NI_LIVE"):
            self.assertNotIn(name, ss.NAMES)


class RoundTrip(unittest.TestCase):
    def setUp(self):
        self.pem, self.public, self.kid = ss.new_key()

    def test_values_arrive_exactly(self):
        block = seal(SECRET, self.public, {"env": "production", "commit": "0" * 40})
        sealed = ss.open_block(ss.extract_block("build line\n" + block + "\nmore lines\n"), self.pem)
        self.assertEqual(sealed["values"], SECRET)
        self.assertEqual(sealed["commit"], "0" * 40)

    def test_no_value_is_in_the_block(self):
        block = seal(SECRET, self.public)
        for value in SECRET.values():
            self.assertNotIn(value.strip(), block)
        self.assertTrue(block.startswith(ss.BEGIN) and block.endswith(ss.END))
        self.assertTrue(all(len(line) <= 76 for line in block.split("\n")))

    def test_another_servers_key_cannot_open_it(self):
        block = seal(SECRET, self.public)
        other_pem, _, _ = ss.new_key()
        with self.assertRaises(SystemExit):
            ss.open_block(ss.extract_block(block), other_pem)

    def test_a_changed_block_does_not_open(self):
        block = seal(SECRET, self.public)
        body = ss.extract_block(block)
        envelope = json.loads(__import__("base64").b64decode(body))
        ct = bytearray(__import__("base64").b64decode(envelope["ct"]))
        ct[0] ^= 1
        envelope["ct"] = __import__("base64").b64encode(bytes(ct)).decode()
        changed = __import__("base64").b64encode(json.dumps(envelope).encode()).decode()
        with self.assertRaises(SystemExit):
            ss.open_block(changed, self.pem)

    def test_a_block_not_from_production_is_refused(self):
        block = seal(SECRET, self.public, {"env": "preview"})
        with self.assertRaises(SystemExit):
            ss.open_block(ss.extract_block(block), self.pem)

    def test_two_blocks_in_one_log_are_refused(self):
        block = seal(SECRET, self.public)
        with self.assertRaises(SystemExit):
            ss.extract_block(block + "\n" + block)

    def test_a_cut_log_is_refused(self):
        block = seal(SECRET, self.public)
        with self.assertRaises(SystemExit):
            ss.extract_block(block[: len(block) // 2])


class Build(unittest.TestCase):
    """The script as the build runs it: `node scripts/seal-settings.mjs`."""

    def run_script(self, env):
        e = {"PATH": os.environ["PATH"]}
        e.update(env)
        return subprocess.run(["node", str(SEAL)], capture_output=True, text=True, env=e)

    def test_inert_without_the_flag(self):
        r = self.run_script(dict(SECRET, VERCEL_ENV="production"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_inert_outside_production(self):
        for env in ({"VERCEL_ENV": "preview"}, {}, {"VERCEL_ENV": "production", "VERCEL_TARGET_ENV": "staging"}):
            r = self.run_script(dict(SECRET, NI_SEAL_SETTINGS="1", **env))
            self.assertEqual(r.returncode, 0)
            self.assertNotIn(ss.BEGIN, r.stdout)
            self.assertIn("not a production build", r.stdout)

    def test_a_production_build_prints_one_block_and_no_value(self):
        if not (SEAL.parent / "seal-settings.pub").exists():
            self.skipTest("no server key committed yet")
        r = self.run_script(dict(SECRET, NI_SEAL_SETTINGS="1", VERCEL_ENV="production", VERCEL_GIT_COMMIT_SHA="0" * 40, VERCEL_DEPLOYMENT_ID="dpl_madeup"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.count(ss.BEGIN), 1)
        for value in SECRET.values():
            self.assertNotIn(value.strip(), r.stdout + r.stderr)
        self.assertIn("4 of %d settings sealed" % len(ss.NAMES), r.stdout)
        self.assertIn("not in this build: ADMIN_EMAILS", r.stdout)


    def test_no_deployment_id_no_block(self):
        r = self.run_script(dict(SECRET, NI_SEAL_SETTINGS="1", VERCEL_ENV="production"))
        self.assertEqual(r.returncode, 0)
        self.assertNotIn(ss.BEGIN, r.stdout)


NOW_MS = 1_800_000_000_000
META = {"env": "production", "deployment": "dpl_madeup", "sealedAt": "2027-01-15T08:05:00Z"}  # NOW_MS + 5 minutes


class Origin(unittest.TestCase):
    def setUp(self):
        self.pem, self.public, _ = ss.new_key()

    def sealed(self, **meta):
        return ss.open_block(ss.extract_block(seal(SECRET, self.public, dict(META, **meta))), self.pem)

    def test_the_deployment_it_was_cut_from(self):
        ss.check_origin(self.sealed(), "dpl_madeup", NOW_MS)

    def test_a_block_naming_another_deployment_is_refused(self):
        with self.assertRaises(SystemExit):
            ss.check_origin(self.sealed(deployment="dpl_other"), "dpl_madeup", NOW_MS)

    def test_an_old_or_early_block_is_refused(self):
        with self.assertRaises(SystemExit):
            ss.check_origin(self.sealed(sealedAt="2027-01-15T11:00:00Z"), "dpl_madeup", NOW_MS)
        with self.assertRaises(SystemExit):
            ss.check_origin(self.sealed(sealedAt="2027-01-15T07:00:00Z"), "dpl_madeup", NOW_MS)

    def test_odd_fields_are_refused_before_anything_is_written(self):
        with self.assertRaises(SystemExit):
            self.sealed(commit=12345)

    def test_what_is_printed_cannot_carry_escapes(self):
        self.assertEqual(ss.shown("dpl_\x1b]0;x\x07ok"), "dpl_??0?x?ok")

    def test_production_id_wants_the_apps_project(self):
        d = {"id": "dpl_madeup", "target": "production", "createdAt": NOW_MS, "projectId": "prj_madeup"}
        run = lambda project: subprocess.run([sys.executable, "-I", str(APP / "sealed_settings.py"), "production-id", project],
                                             input=json.dumps(d), capture_output=True, text=True)
        self.assertEqual(run("prj_madeup").stdout.split(), ["dpl_madeup", str(NOW_MS)])
        self.assertNotEqual(run("prj_other").returncode, 0)


class OpenOnTheServer(unittest.TestCase):
    """`sealed_settings.py open`, end to end, against a made-up env file."""

    def test_writes_reports_and_forgets_the_key(self):
        pem, public, _ = ss.new_key()
        block = seal(SECRET, public, META)
        with tempfile.TemporaryDirectory() as d:
            key, env = os.path.join(d, "settings.key"), os.path.join(d, ".env")
            Path(key).write_bytes(pem)
            Path(env).write_text("CREDENTIAL_ENCRYPTION_KEY=\nRUN_SKILL_INTERNAL_SECRET=rehearsal-made-up\nEMAIL_FROM='Made Up <hello@example.dev>'\nOTHER=kept\n")
            os.chmod(env, 0o600)
            r = subprocess.run([sys.executable, "-I", str(APP / "sealed_settings.py"), "open", key, env, str(ENVFILE), "dpl_madeup", str(NOW_MS)],
                               input="log line\n" + block + "\n", capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            written = ss.parse_env(Path(env).read_text())
            self.assertEqual(written["CREDENTIAL_ENCRYPTION_KEY"], SECRET["CREDENTIAL_ENCRYPTION_KEY"])
            self.assertEqual(written["RUN_SKILL_INTERNAL_SECRET"], SECRET["RUN_SKILL_INTERNAL_SECRET"])
            self.assertEqual(written["OTHER"], "kept")
            self.assertNotIn("TWILIO_PHONE_NUMBER", written)  # no line for it: never added
            self.assertFalse(os.path.exists(key))
            out = r.stdout + r.stderr
            for value in SECRET.values():
                self.assertNotIn(value.strip(), out)
            self.assertRegex(out, r"CREDENTIAL_ENCRYPTION_KEY\s+filled")
            self.assertRegex(out, r"RUN_SKILL_INTERNAL_SECRET\s+replaced")
            self.assertRegex(out, r"EMAIL_FROM\s+the same")
            self.assertRegex(out, r"TWILIO_PHONE_NUMBER\s+no line in the file")
            self.assertRegex(out, r"ADMIN_EMAILS\s+not in the block")

    def test_a_used_key_is_gone(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, "-I", str(APP / "sealed_settings.py"), "open", os.path.join(d, "none.key"), os.path.join(d, ".env"), str(ENVFILE), "dpl_madeup", str(NOW_MS)],
                               input="", capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no private key", r.stderr)


class CutHere(unittest.TestCase):
    def test_cut_takes_the_block_out_of_the_log_events(self):
        _, public, _ = ss.new_key()
        block = seal(SECRET, public)
        events = [{"type": "stdout", "text": "> build"}] + [{"type": "stdout", "text": line} for line in block.split("\n")] + [{"type": "stdout", "text": "done"}]
        r = subprocess.run([sys.executable, "-I", str(APP / "sealed_settings.py"), "cut"], input=json.dumps(events), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), block)


if __name__ == "__main__":
    unittest.main()
