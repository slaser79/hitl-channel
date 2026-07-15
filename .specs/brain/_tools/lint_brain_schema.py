#!/usr/bin/env python3
"""Lint script to enforce brain entity contract."""

import re
import sys
from pathlib import Path

import yaml

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)

REQUIRED_KEYS = {"id", "domain", "entity", "status"}
REQUIRED_RELATIONSHIPS = {
    "defines",
    "implements",
    "depends_on",
    "governs",
    "triggers",
    "supersedes",
}


def lint_file(file_path: Path) -> list[str]:
    """Lints a single markdown entity file.

    Returns a list of errors (empty list means compliant).
    """
    errors = []
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        return [f"Failed to read file: {e}"]

    match = _FRONTMATTER_RE.match(content.lstrip("\ufeff").lstrip())
    if not match:
        return ["Missing frontmatter block (starts and ends with ---)"]

    frontmatter_str = match.group(1)
    try:
        data = yaml.safe_load(frontmatter_str)
    except Exception as e:
        return [f"Invalid YAML in frontmatter: {e}"]

    if not isinstance(data, dict):
        return ["Frontmatter must be a key-value mapping (dict)"]

    # Check for missing required top-level keys
    missing_required = REQUIRED_KEYS - data.keys()
    if missing_required:
        errors.append(f"Missing required top-level field(s): {', '.join(sorted(missing_required))}")

    # Check relationships block
    if "relationships" not in data:
        errors.append("Missing 'relationships' block")
    else:
        relationships = data["relationships"]
        if not isinstance(relationships, dict):
            errors.append("'relationships' must be a mapping (dict)")
        else:
            missing_rel_keys = REQUIRED_RELATIONSHIPS - relationships.keys()
            if missing_rel_keys:
                errors.append(
                    f"Missing keys in 'relationships' block: {', '.join(sorted(missing_rel_keys))}"
                )

    return errors


def main() -> int:
    # Determine directory to scan
    entities_dir = None
    if len(sys.argv) > 1:
        arg_path = Path(sys.argv[1])
        if (arg_path / ".specs/brain/entities").is_dir():
            entities_dir = arg_path / ".specs/brain/entities"
        elif arg_path.is_dir():
            entities_dir = arg_path
        else:
            print(f"Error: Path {arg_path} is not a directory.", file=sys.stderr)
            return 1
    else:
        # Default: try relative to script, or fallback to current directory
        script_dir_entities = Path(__file__).parent.parent / "entities"
        if script_dir_entities.is_dir():
            entities_dir = script_dir_entities
        elif Path(".specs/brain/entities").is_dir():
            entities_dir = Path(".specs/brain/entities")
        else:
            print("Error: Could not locate .specs/brain/entities directory.", file=sys.stderr)
            return 1

    md_files = sorted(list(entities_dir.rglob("*.md")))
    if not md_files:
        print(f"Warning: No markdown files found in {entities_dir}", file=sys.stderr)
        return 0

    all_errors = {}
    ok_count = 0

    for file_path in md_files:
        errors = lint_file(file_path)
        if errors:
            all_errors[file_path.name] = errors
        else:
            ok_count += 1

    if all_errors:
        print(
            f"Lint failed: {len(all_errors)} files with errors found under {entities_dir}.",
            file=sys.stderr,
        )
        for filename, errors in sorted(all_errors.items()):
            print(f"  {filename}:", file=sys.stderr)
            for err in errors:
                print(f"    - {err}", file=sys.stderr)
        return 1

    print(f"{ok_count} pages OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
