"""The coding agent's sandbox image is the agent framework's own base image,
at the version of the framework the app uses. The two are written in two
places (deploy/sandbox/image.py and web/package.json), and nothing but this
test notices when only one of them moves: the agent would then run in an image
made for another version of itself.
"""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


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


if __name__ == "__main__":
    unittest.main()
