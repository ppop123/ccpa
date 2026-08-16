#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

STABLE_REQUIRED = [
    "AGENTS.md",
    "README.md",
    "ARCHITECTURE.md",
    "docs/README.md",
    "docs/AGENT_GUIDE.md",
    "docs/QUALITY.md",
    "scripts/verify.sh",
    "scripts/smoke.sh",
]

WORKING_LOGS = ["task_plan.md", "findings.md", "progress.md"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check the CCPA repository harness.")
    parser.add_argument(
        "--with-working-logs",
        action="store_true",
        help="also require the local task_plan.md, findings.md, and progress.md working logs",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    required = [*STABLE_REQUIRED, *(WORKING_LOGS if args.with_working_logs else [])]
    root = Path.cwd()
    missing = [path for path in required if not (root / path).exists()]

    if missing:
        print("Missing harness files:")
        for item in missing:
            print(f"  - {item}")
        return 1

    print("Harness check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
