"""The images this server's runtime starts sandboxes from (deploy/sandbox/image.py).

The coding agent's is the agent framework's own base image, at the version of the
framework the app uses. The two are written in two places (deploy/sandbox/image.py
and web/package.json), and nothing but this test notices when only one of them
moves: the agent would then run in an image made for another version of itself.

The cloud browser's is made from the same four scripts as the hosted service's
base snapshot (web/scripts/cloud-browser/base): this test holds the two to the
same files, and the scripts to the hosted image's profile when nothing names
another.
"""
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE_SCRIPTS = ROOT / "web" / "scripts" / "cloud-browser" / "base"


def load_image():
    spec = importlib.util.spec_from_file_location("sandbox_image", ROOT / "deploy" / "sandbox" / "image.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImageDefinition(unittest.TestCase):
    def setUp(self):
        self.image = load_image()

    def test_the_base_image_is_the_frameworks_at_the_apps_version(self):
        package = json.loads((ROOT / "web" / "package.json").read_text())
        version = package["dependencies"]["eve"]
        self.assertRegex(version, r"^\d+\.\d+\.\d+$", "the app pins the framework to an exact version")
        self.assertEqual(self.image.BASE, f"ghcr.io/vercel/eve:{version}")

    def test_importing_the_definition_needs_no_client(self):
        # setup.sh's checks and this test read the definition on machines without the runtime's client.
        self.assertEqual(self.image.NAME, "ni-coding-agent")

    def test_the_definition_changes_with_the_disk_limit(self):
        # An image keeps the disk it was built with, so another limit must mean another build.
        self.assertNotEqual(self.image.definition(512), self.image.definition(16384))
        self.assertEqual(self.image.definition(16384), self.image.definition(16384))

    def test_what_the_agent_needs_names_no_tool_the_base_image_lacks(self):
        # Read off the base image at 0.79.1: it has no git-lfs, and the hosted sandboxes have none either.
        self.assertNotIn("git-lfs", self.image.NEEDS)
        for tool in ("bash", "git", "node", "rg"):
            self.assertIn(tool, self.image.NEEDS)


class TheCodingAgentsImageIsUnchanged(unittest.TestCase):
    """Two images instead of one: the coding agent's must come out of it as it was,
    or the server builds it again for nothing (and a build that went wrong would
    take coding runs with it)."""

    def setUp(self):
        self.image = load_image()

    def test_its_definition_is_the_one_this_server_already_built(self):
        # The hashes image.py gave before it had a second image, at the server's
        # limit (16 GiB) and at the runtime's own (512 MiB).
        self.assertEqual(self.image.definition(16384), "af923c419fa9a2608f3b89dbdd4ba30db28c679a53d1be7a3c639b4f4ed42927")
        self.assertEqual(self.image.definition(512), "32a8ed358875d6617b9bff74701a99bed6c25ea5c376d24202add3ced04a28dd")
        self.assertEqual(self.image.definition(16384), self.image.IMAGES["ni-coding-agent"].definition(16384))

    def test_its_name_size_record_and_steps(self):
        coding = self.image.IMAGES["ni-coding-agent"]
        self.assertEqual((coding.name, coding.base, coding.cpus, coding.memory_mb), ("ni-coding-agent", self.image.BASE, 2, 4096))
        self.assertEqual(str(coding.record), "/etc/ni-sandbox/image.ni-coding-agent")
        self.assertEqual(coding.steps, self.image.STEPS)
        self.assertEqual(len(coding.steps), 2)

    def test_the_coding_agents_is_built_and_checked_first(self):
        self.assertEqual(list(self.image.IMAGES), ["ni-coding-agent", "ni-cloud-browser"])


class TheCloudBrowsersImage(unittest.TestCase):
    def setUp(self):
        self.image = load_image()
        self.browser = self.image.IMAGES["ni-cloud-browser"]

    def test_its_name_size_and_record(self):
        self.assertEqual(self.browser.name, "ni-cloud-browser")
        self.assertEqual(self.browser.cpus, 2)
        # The product's decision: 4 GB (web/src/lib/cloud-browser/config.ts says 2 vCPU / 4 GB).
        self.assertEqual(self.browser.memory_mb, 4096)
        self.assertEqual(str(self.browser.record), "/etc/ni-sandbox/image.ni-cloud-browser")
        # setup.sh removes /etc/ni-sandbox/image.* when the disk limit moves: both are under it.
        self.assertNotEqual(self.browser.record, self.image.RECORD)

    def test_its_base_is_an_exact_node_tag_of_22_or_later(self):
        m = re.fullmatch(r"node:(\d+)\.(\d+)\.(\d+)-bookworm", self.browser.base)
        self.assertIsNotNone(m, "an exact tag, never a moving one")
        self.assertGreaterEqual(int(m.group(1)), 22)

    def test_the_resolvers_come_first(self):
        # A step that fetches anything must come after the image's resolvers (README, "The resolver").
        self.assertEqual(self.browser.steps[0], self.image.STEPS[0])
        self.assertIn("/etc/resolv.conf", self.browser.steps[0][1])

    def test_it_is_made_from_the_hosted_snapshots_own_four_scripts(self):
        hosted = (ROOT / "web" / "scripts" / "cloud-browser" / "build-base-snapshot.sh").read_text()
        listed = re.search(r"^for f in ([^;]+); do$", hosted, re.M).group(1).split()
        self.assertEqual(listed, self.image.BROWSER_FILES)
        written = "\n".join(command for _, command in self.browser.steps)
        for name in self.image.BROWSER_FILES:
            self.assertIn("/tmp/cloud-browser-base/%s" % name, written)

    def test_the_profiles_place_is_written_before_install_runs(self):
        commands = [command for _, command in self.browser.steps]
        env_at = next(i for i, c in enumerate(commands) if self.image.BROWSER_ENV_FILE in c)
        install_at = next(i for i, c in enumerate(commands) if c.startswith("bash /tmp/cloud-browser-base/install.sh"))
        chown_at = next(i for i, c in enumerate(commands) if "chown -R user:user /home/user/profile" in c)
        self.assertLess(env_at, install_at)
        self.assertLess(install_at, chown_at)
        # Every step as root: install.sh's sudo then asks for nothing.
        self.assertEqual({user for user, _ in self.browser.steps}, {"root"})

    def test_a_change_of_a_script_changes_the_definition(self):
        before = self.browser.definition(16384)
        with tempfile.TemporaryDirectory() as folder:
            for name in self.image.BROWSER_FILES:
                (Path(folder) / name).write_text((BASE_SCRIPTS / name).read_text())
            self.image.BROWSER_SCRIPTS = Path(folder)
            self.assertEqual(self.browser.definition(16384), before)
            (Path(folder) / "stop.sh").write_text((BASE_SCRIPTS / "stop.sh").read_text() + "\n# changed\n")
            self.assertNotEqual(self.browser.definition(16384), before)
        # And the coding agent's does not move with it.
        self.assertEqual(self.image.definition(16384), "af923c419fa9a2608f3b89dbdd4ba30db28c679a53d1be7a3c639b4f4ed42927")

    def test_the_files_are_written_exactly(self):
        # Each script goes into the image inside its step, as base64: decoding a
        # step gives back the file, byte for byte.
        import base64

        for name in self.image.BROWSER_FILES:
            step = next(c for _, c in self.browser.steps if c.endswith("> /tmp/cloud-browser-base/%s" % name))
            data = re.search(r"printf %s '([A-Za-z0-9+/=]+)'", step).group(1)
            self.assertEqual(base64.b64decode(data).decode(), (BASE_SCRIPTS / name).read_text(), name)

    def test_the_check_runs_start_detached_and_reads_cdp_on_loopback(self):
        self.assertIn("setsid bash /opt/cloud-browser/start.sh", self.image.BROWSER_START)
        self.assertIn("http://127.0.0.1:9222/json/version", self.image.BROWSER_START)
        self.assertIn("bash /opt/cloud-browser/stop.sh", self.image.BROWSER_STOP)
        # The app's own paths (web/src/lib/cloud-browser/config.ts).
        config = (ROOT / "web" / "src" / "lib" / "cloud-browser" / "config.ts").read_text()
        self.assertIn("startScript: '/opt/cloud-browser/start.sh'", config)
        self.assertIn("stopScript: '/opt/cloud-browser/stop.sh'", config)


class TheProfilesPlace(unittest.TestCase):
    """install.sh and start.sh find the profile the same way: in the file the image
    names it in, else where the hosted image has always had it."""

    def resolve(self, script, env_text=None):
        text = (BASE_SCRIPTS / script).read_text()
        lines = [l for l in text.splitlines() if "/etc/opt/cloud-browser/env" in l and l.startswith("[ -r")]
        lines += [l for l in text.splitlines() if l.startswith("PROFILE=")]
        self.assertEqual(len(lines), 2, script)
        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / "env"
            if env_text is not None:
                env_file.write_text(env_text)
            body = "\n".join(lines).replace("/etc/opt/cloud-browser/env", str(env_file)) + '\nprintf %s "$PROFILE"\n'
            done = subprocess.run(["bash", "-euc", body], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout

    def test_the_hosted_images_place_without_the_file(self):
        for script in ("install.sh", "start.sh"):
            self.assertEqual(self.resolve(script), "/home/ubuntu/profile", script)

    def test_the_place_the_file_names(self):
        image = load_image()
        for script in ("install.sh", "start.sh"):
            self.assertEqual(self.resolve(script, "CLOUD_BROWSER_PROFILE=%s\n" % image.BROWSER_PROFILE), "/home/user/profile", script)

    def test_the_hosted_snapshot_still_resets_the_hosted_profile(self):
        hosted = (ROOT / "web" / "scripts" / "cloud-browser" / "build-base-snapshot.sh").read_text()
        self.assertIn("rm -rf /home/ubuntu/profile", hosted)
        self.assertNotIn("/etc/opt/cloud-browser/env", hosted)


if __name__ == "__main__":
    unittest.main()
