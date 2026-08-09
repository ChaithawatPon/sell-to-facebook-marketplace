#!/usr/bin/env python3
"""Copy this skill package to an explicit, empty destination parent."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

IGNORED_NAMES = {
    ".DS_Store",
    "node_modules",
    "output",
    "state",
}


def contains_symlink(path: Path) -> bool:
    return any(item.is_symlink() for item in path.rglob("*") if not any(part in IGNORED_NAMES for part in item.parts))


def ignore_runtime_dirs(_directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in IGNORED_NAMES}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill", choices=["sell-to-facebook-marketplace"])
    parser.add_argument("--dest", required=True, type=Path, help="Existing destination directory")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)

    root = args.root.resolve()
    source = (root / args.skill).resolve()
    destination_parent = args.dest.expanduser().resolve()

    if not source.is_relative_to(root) or not (source / "SKILL.md").is_file():
        print("error: skill must be an installable package inside --root", file=sys.stderr)
        return 2
    if contains_symlink(source):
        print("error: source contains a symlink", file=sys.stderr)
        return 2
    if not destination_parent.is_dir():
        print("error: --dest must be an existing directory", file=sys.stderr)
        return 2

    target = destination_parent / source.name
    if target.exists() or target.is_symlink():
        print(f"error: refusing to overwrite existing target: {target}", file=sys.stderr)
        return 3

    shutil.copytree(source, target, symlinks=False, ignore=ignore_runtime_dirs)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
