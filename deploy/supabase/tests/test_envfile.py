"""Tests for envfile.py's prompt: python3 -m unittest discover -s deploy/supabase/tests

Every value here is made up.
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import envfile  # noqa: E402


class Prompt(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".env")
        with os.fdopen(fd, "w") as f:
            f.write("A=\nB=kept\nC=\n")
        os.chmod(self.path, 0o600)

    def tearDown(self):
        os.unlink(self.path)

    def run_prompt(self, names, answers):
        out = io.StringIO()
        with mock.patch.object(envfile.getpass, "getpass", side_effect=answers), \
                mock.patch.object(envfile.sys, "argv", ["envfile.py", "prompt", self.path] + names), \
                mock.patch.object(envfile.sys.stdin, "isatty", return_value=True), \
                contextlib.redirect_stdout(out):
            envfile.main()
        with open(self.path) as f:
            return f.read(), out.getvalue()

    def test_an_empty_answer_leaves_that_one_and_writes_the_rest(self):
        text, out = self.run_prompt(["A", "B", "C"], ["made-up-a", "", "made-up-c"])
        self.assertEqual(text, "A=made-up-a\nB=kept\nC=made-up-c\n")
        self.assertIn("B: left as it was", out)
        self.assertNotIn("made-up", out)

    def test_nothing_entered_changes_nothing(self):
        text, out = self.run_prompt(["A", "C"], ["", ""])
        self.assertEqual(text, "A=\nB=kept\nC=\n")
        self.assertIn("not changed", out)

    def test_a_line_break_is_kept_when_asked(self):
        text, _ = self.run_prompt(["A+nl"], ["made-up"])
        self.assertEqual(text, 'A="made-up\\n"\nB=kept\nC=\n')


if __name__ == "__main__":
    unittest.main()
