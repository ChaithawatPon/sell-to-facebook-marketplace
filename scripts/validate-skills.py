#!/usr/bin/env python3
"""Validate the public collection's portable, text-only package contract."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REQUIRED_ROOT_DOCS = {
    "README.md", "LICENSE", "AGENTS.md", "CLAUDE.md", "CODEX.md",
    "CONTEXT.md", "SKILLS.md",
}
ALLOWED_ROOT_FILES = REQUIRED_ROOT_DOCS | {".gitignore", ".gitmodules"}
ALLOWED_ROOT_DIRECTORIES = {".github", "scripts", ".git"}
PACKAGE_CHILDREN = {
    "SKILL.md", "README.md", "agents", "lib", "scripts", "references", "assets", "tests",
    "bin", "server", "docs", "package.json", "package-lock.json", "setup.js",
    "FixBill", "tsconfig.base.json", "CLAUDE.md", "Output",
}
TEXT_SUFFIXES = {
    ".md", ".py", ".yaml", ".yml", ".sh", ".txt", ".js", ".ts", ".json",
    ".ttf", ".png", ".cjs", ".mjs", ".example", ".gitkeep",
}
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
TOP_LEVEL_YAML = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):", re.MULTILINE)
HOME_PATH = re.compile(r"/(?:Users|home)/(?!<(?:user|username)>/)[A-Za-z0-9._-]+/")
PRIVATE_CONTENT = re.compile(
    r"(?:claude-skills-private|private backup|internal-only|confidential customer)",
    re.IGNORECASE,
)
STALE_FIXBILL = re.compile(r"github\.com/iampon-p/fixbill(?!-cli)", re.IGNORECASE)
LABELED_SECRET = re.compile(
    r"(?:api[_ -]?key|secret|password|(?:access[_ -]?)?token)\s*[:=]\s*[\"']?([A-Za-z0-9_./+-]{8,})",
    re.IGNORECASE,
)
TOKEN_SECRET = re.compile(r"\b(?:ghp|github_pat|sk_(?:live|prod))_[A-Za-z0-9_-]{12,}\b", re.IGNORECASE)
DUMMY_VALUE = re.compile(
    r"(?:dummy|example|placeholder|changeme|redacted|fake|test|abcd|xxxxx|00000)",
    re.IGNORECASE,
)
SAFE_SECRET_CONTEXT = re.compile(
    r"(?:os\.environ|os\.getenv|process\.env|\$\{|<[^>]+>|re\.compile|PATTERNS?\s*=|refresh_token|access_token|googleAccessToken|setCredentials|GOOGLE_CLIENT_SECRET|serverEnvSchema)",
    re.IGNORECASE,
)
INVENTORY_ROW = re.compile(r"^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$", re.MULTILINE)


def add(errors: list[str], message: str) -> None:
    errors.append(message)


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def ignored(path: Path) -> bool:
    return ".git" in path.parts or "__pycache__" in path.parts


def package_paths(root: Path, errors: list[str]) -> list[Path]:
    packages: list[Path] = []
    # Search root directory for skill packages
    for parent in [root]:
        for child in sorted(parent.iterdir()):
            if child.name in ALLOWED_ROOT_DIRECTORIES:
                continue
            if not child.is_dir():
                continue
            if not (child / "SKILL.md").is_file():
                add(errors, f"directory must be a skill package with SKILL.md: {rel(root, child)}")
                continue
            packages.append(child)
            for item in child.iterdir():
                # A package may be a git submodule (its own repo): skip the
                # submodule bookkeeping files it carries.
                if item.name in {".git", ".gitignore", ".gitmodules"}:
                    continue
                if item.name not in PACKAGE_CHILDREN:
                    add(errors, f"unapproved package child: {rel(root, item)}")
    return sorted(packages)


def validate_frontmatter(root: Path, package: Path, names: dict[str, Path], errors: list[str]) -> None:
    skill = package / "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    match = FRONTMATTER.match(text)
    if not match:
        add(errors, f"missing YAML frontmatter: {rel(root, skill)}")
        return
    frontmatter = match.group(1)
    keys = TOP_LEVEL_YAML.findall(frontmatter)
    if set(keys) != {"name", "description"} or len(keys) != 2:
        add(errors, f"frontmatter must contain only name and description: {rel(root, skill)}")
        return
    name_match = re.search(r"^name:\s*([^\s#]+)\s*$", frontmatter, re.MULTILINE)
    if not name_match:
        add(errors, f"missing scalar name: {rel(root, skill)}")
        return
    name = name_match.group(1)
    if not NAME.fullmatch(name):
        add(errors, f"invalid skill name syntax: {rel(root, skill)}")
    elif name != package.name:
        add(errors, f"frontmatter name does not match folder: {rel(root, skill)}")
    elif name in names:
        add(errors, f"duplicate skill name {name}: {rel(root, skill)} and {rel(root, names[name])}")
    else:
        names[name] = skill


def validate_inventory(root: Path, packages: list[Path], errors: list[str]) -> None:
    rows = INVENTORY_ROW.findall((root / "SKILLS.md").read_text(encoding="utf-8"))
    paths = {row[0] for row in rows}
    expected = {rel(root, package) for package in packages}
    if paths != expected:
        missing = sorted(expected - paths)
        extra = sorted(paths - expected)
        if missing:
            add(errors, f"inventory missing packages: {', '.join(missing)}")
        if extra:
            add(errors, f"inventory lists unknown packages: {', '.join(extra)}")
    for path, status, dependencies, note in rows:
        if not status.strip() or not dependencies.strip() or not note.strip():
            add(errors, f"inventory row requires status, dependencies, and notes: {path}")


def validate_text(root: Path, path: Path, errors: list[str]) -> None:
    relative = rel(root, path)
    if path.name not in ALLOWED_ROOT_FILES and path.name not in {"FixBill", ".gitkeep"} and path.suffix.lower() not in TEXT_SUFFIXES:
        add(errors, f"unsupported repository file: {relative}")
        return
    if path.suffix.lower() in {".ttf", ".png"}:
        return
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        add(errors, f"binary or non-UTF-8 file is forbidden: {relative}")
        return
    if "\x00" in text:
        add(errors, f"binary file is forbidden: {relative}")
    if path.resolve() == Path(__file__).resolve():
        return
    if (HOME_PATH.search(text) or PRIVATE_CONTENT.search(text)) and not relative.startswith("fixbill/"):
        add(errors, f"private path/reference: {relative}")
    if STALE_FIXBILL.search(text):
        add(errors, f"stale FixBill repository URL: {relative}")
    for line in text.splitlines():
        match = LABELED_SECRET.search(line)
        if match and not DUMMY_VALUE.search(match.group(1)) and not SAFE_SECRET_CONTEXT.search(line):
            add(errors, f"possible secret value: {relative}")
            break
    for match in TOKEN_SECRET.finditer(text):
        if not DUMMY_VALUE.search(match.group(0)):
            add(errors, f"possible token value: {relative}")
            break


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root = args.root.resolve()
    errors: list[str] = []
    names: dict[str, Path] = {}

    for document in sorted(REQUIRED_ROOT_DOCS):
        if not (root / document).is_file():
            add(errors, f"missing root document: {document}")
    for item in root.iterdir():
        if item.is_dir():
            if item.name not in ALLOWED_ROOT_DIRECTORIES and not (item / "SKILL.md").is_file():
                add(errors, f"unapproved root entry: {item.name}")
        elif item.name not in ALLOWED_ROOT_FILES:
            add(errors, f"unapproved root entry: {item.name}")
    for path in root.rglob("*"):
        if not ignored(path) and path.is_symlink():
            add(errors, f"symlink is forbidden: {rel(root, path)}")

    packages = package_paths(root, errors)
    if not packages:
        add(errors, "no skill packages found")
    for package in packages:
        if list(package.rglob("SKILL.md")) != [package / "SKILL.md"]:
            add(errors, f"package must contain exactly one SKILL.md: {rel(root, package)}")
        try:
            validate_frontmatter(root, package, names, errors)
        except UnicodeDecodeError:
            add(errors, f"SKILL.md must be UTF-8: {rel(root, package / 'SKILL.md')}")

    for path in root.rglob("*"):
        if ignored(path) or not path.is_file() or path.is_symlink():
            continue
        validate_text(root, path, errors)
    if (root / "SKILLS.md").is_file():
        validate_inventory(root, packages, errors)

    if errors:
        print("validation failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"validated {len(packages)} skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
