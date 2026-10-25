import importlib.util
import pathlib
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("save_archive_check", pathlib.Path(__file__).with_name("save-archive-check.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ArchiveCompletenessTests(unittest.TestCase):
    def inspect(self, levels, extra=(), empty=()):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "fixture.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for member in ["script.dat", "info.json", *levels, *extra]:
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", UserWarning)
                        archive.writestr("fixture/" + member, b"" if member in empty else b"offline-fixture")
            return checker.inspect_save(path)

    def test_native_one_chunk_is_complete_with_metadata(self):
        proof = self.inspect(["level.dat0", "level.datmetadata"])
        self.assertEqual(proof["native_level_chunks"], [0])
        self.assertEqual(proof["zip_integrity"], "pass")

    def test_native_multi_chunk_is_complete(self):
        self.assertEqual(self.inspect(["level.dat0", "level.dat1", "level.datmetadata"])["native_level_chunks"], [0, 1])

    def test_missing_metadata_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "level data incomplete"):
            self.inspect(["level.dat0"])

    def test_hole_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "level data incomplete"):
            self.inspect(["level.dat0", "level.dat2", "level.datmetadata"])

    def test_missing_chunk_zero_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "level data incomplete"):
            self.inspect(["level.dat1", "level.datmetadata"])

    def test_metadata_without_any_chunk_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "level data incomplete"):
            self.inspect(["level.datmetadata"])

    def test_duplicate_members_are_rejected(self):
        with self.assertRaisesRegex(AssertionError, "Duplicate"):
            self.inspect(["level.dat0", "level.datmetadata"], ["script.dat"])

    def test_legacy_level_data_still_supported(self):
        self.assertEqual(self.inspect(["level.dat"])["native_level_layout"], "legacy")

    def test_empty_required_members_are_rejected(self):
        for member in ("level.dat0", "level.datmetadata", "script.dat", "info.json"):
            with self.subTest(member=member), self.assertRaisesRegex(AssertionError, "Empty required"):
                self.inspect(["level.dat0", "level.datmetadata"], empty=[member])

    def test_traversal_and_unsafe_path_components_are_rejected(self):
        for member in ("../outside", "./outside", "nested//outside", "drive:outside", "back\\slash"):
            with self.subTest(member=member), self.assertRaisesRegex(AssertionError, "Unsafe save member"):
                self.inspect(["level.dat0", "level.datmetadata"], extra=[member])


if __name__ == "__main__":
    unittest.main(verbosity=2)
