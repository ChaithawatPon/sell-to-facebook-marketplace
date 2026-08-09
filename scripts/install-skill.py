#!/usr/bin/env python3
"""Copy this skill package to an explicit, empty destination parent."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import uuid
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


def resolve_npm_bin(npm_bin: str | None) -> str:
    return npm_bin or os.environ.get("MARKETPLACE_SKILL_NPM_BIN", "npm")


def install_dependencies(target: Path, npm_bin: str) -> None:
    command = [npm_bin]
    if (target / "package-lock.json").is_file():
        command.extend(["ci", "--omit=dev"])
    else:
        command.extend(["install", "--omit=dev"])
    subprocess.run(command, cwd=target, check=True, stdout=sys.stderr, stderr=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill", choices=["sell-to-facebook-marketplace"])
    parser.add_argument("--dest", required=True, type=Path, help="Existing destination directory")
    parser.add_argument("--npm-bin", help="npm executable to use for destination dependency install")
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

    temp_target = destination_parent / f".{source.name}.installing-{uuid.uuid4().hex}"
    npm_bin = resolve_npm_bin(args.npm_bin)

    try:
        shutil.copytree(source, temp_target, symlinks=False, ignore=ignore_runtime_dirs)
        install_dependencies(temp_target, npm_bin)
        temp_target.replace(target)
    except (OSError, subprocess.CalledProcessError) as error:
        shutil.rmtree(temp_target, ignore_errors=True)
        print(f"error: installation failed and was rolled back: {error}", file=sys.stderr)
        return 4

    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
