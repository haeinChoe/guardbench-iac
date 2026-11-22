import tempfile
import unittest
from pathlib import Path

from scripts.performance import s3results


class FakeS3:
    def __init__(self, objects):
        self.objects = dict(objects)
        self.uploads = {}

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        outer = self

        class Paginator:
            def paginate(self, Bucket, Prefix):  # noqa: N803
                return [{"Contents": [{"Key": k} for k in sorted(outer.objects) if k.startswith(Prefix)]}]

        return Paginator()

    def download_file(self, bucket, key, filename):
        Path(filename).write_text(self.objects[key], encoding="utf-8")

    def upload_file(self, filename, bucket, key):
        self.uploads[(bucket, key)] = Path(filename).read_text(encoding="utf-8")


class S3ResultsTest(unittest.TestCase):
    def test_parse_prefix_requires_bucket_and_prefix(self):
        self.assertEqual(s3results.parse_s3_prefix("s3://b/a/b"), ("b", "a/b/"))
        for bad in ("http://b/a", "s3://b", "s3://b/", "s3:///a"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                s3results.parse_s3_prefix(bad)

    def test_download_keeps_relative_layout(self):
        s3 = FakeS3({"p/run/result.json": "{}", "p/run/runner-exit-code": "0\n", "p/other/x": "no"})
        with tempfile.TemporaryDirectory() as directory:
            files = s3results.download_prefix(s3, "s3://b/p/run/", directory)
            self.assertEqual(files, ["result.json", "runner-exit-code"])
            self.assertEqual((Path(directory) / "runner-exit-code").read_text(encoding="utf-8"), "0\n")

    def test_download_rejects_keys_that_escape_the_destination(self):
        s3 = FakeS3({"p/run/../../escape": "x"})
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            s3results.download_prefix(s3, "s3://b/p/run/", directory)

    def test_download_of_an_empty_prefix_returns_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(s3results.download_prefix(FakeS3({}), "s3://b/p/run/", directory), [])

    def test_upload_preserves_relative_names(self):
        s3 = FakeS3({})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sub").mkdir()
            (root / "final.json").write_text("a", encoding="utf-8")
            (root / "sub" / "summary.md").write_text("b", encoding="utf-8")
            files = s3results.upload_directory(s3, root, "s3://b/p/run/")
        self.assertEqual(files, ["final.json", "sub/summary.md"])
        self.assertEqual(set(s3.uploads), {("b", "p/run/final.json"), ("b", "p/run/sub/summary.md")})


if __name__ == "__main__":
    unittest.main()
