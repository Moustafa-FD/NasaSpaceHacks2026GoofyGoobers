"""Read one JSON request on stdin and write one JSON result on stdout."""

import json
import sys

from accounting import ScenarioError, build_manifest

MAX_INPUT_BYTES = 1_000_000


def reject_nonfinite(value: str) -> None:
    raise ScenarioError(f"Non-standard JSON number {value} is not supported")


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ScenarioError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def main() -> int:
    try:
        raw_bytes = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw_bytes) > MAX_INPUT_BYTES:
            raise ScenarioError("Worker request exceeds the input limit")
        raw = raw_bytes.decode("utf-8")
        request = json.loads(raw, parse_constant=reject_nonfinite, object_pairs_hook=unique_object)
        result = build_manifest(request)
        sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n")
        return 0
    except (ScenarioError, json.JSONDecodeError, UnicodeDecodeError) as error:
        sys.stderr.write(json.dumps({"error": {"code": "INVALID_SCENARIO", "message": str(error)}}) + "\n")
        return 1
    except Exception:
        sys.stderr.write(json.dumps({"error": {"code": "MODEL_ERROR", "message": "The illustrative worker could not complete the calculation."}}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
