"""Bounded archival ZIP verification, after independent native-copy load proof."""
import pathlib
import re
import zipfile


def inspect_save(save_path):
    path = pathlib.Path(save_path)
    root = path.stem + "/"
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        entries = archive.namelist()
        assert entries, "Empty save archive"
        assert len(entries) == len(set(entries)), "Duplicate save ZIP entries"
        for name in entries:
            parts = name.rstrip("/").split("/")
            assert not name.startswith("/") and "\\" not in name, "Unsafe save member path"
            assert parts and all(part not in ("..", ".", "") for part in parts), "Unsafe save member path"
            assert not any(":" in part for part in parts), "Unsafe save member path"
        assert all(name.startswith(root) for name in entries), "Save archive root mismatch"
        members = {name[len(root):] for name in entries}
        chunks = sorted(int(match.group(1)) for name in members
                        if (match := re.fullmatch(r"level\.dat(\d+)", name)))
        legacy = "level.dat" in members
        split = ("level.datmetadata" in members and bool(chunks)
                 and chunks == list(range(len(chunks))))
        assert legacy or split, "Save level data incomplete"
        assert {"script.dat", "info.json"} <= members, "Save script/info absent"
        for info in infos:
            suffix = info.filename[len(root):]
            if suffix in {"level.dat", "level.datmetadata", "script.dat", "info.json"} or re.fullmatch(r"level\.dat\d+", suffix):
                assert info.file_size > 0 and not info.is_dir(), "Empty required save member"
        assert archive.testzip() is None, "ZIP CRC/integrity failed"
        return {"zip_integrity": "pass", "archive_entries": len(entries),
                "native_level_layout": "legacy" if legacy else "split",
                "native_level_chunks": chunks}
