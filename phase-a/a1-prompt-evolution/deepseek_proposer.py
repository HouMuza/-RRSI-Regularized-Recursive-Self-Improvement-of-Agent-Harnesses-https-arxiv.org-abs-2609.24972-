"""Generate reviewable A1 prompt candidates with a DeepSeek improver.

DeepSeek proposes mutations. It never scores, accepts, or promotes its own
changes. The frozen official IFEval verifier and the registered paired
selection rule retain those responsibilities.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import certifi


SYSTEM_INSTRUCTION = """You are the proposal component in a controlled prompt evolution experiment.
Return only valid JSON. You may change only the evaluated model's system prompt.
Use the supplied evolution-set failures and mutation history as evidence.
Do not include benchmark answers, example-specific facts, or task identifiers in a candidate prompt.
Each candidate must state a distinct, general hypothesis about instruction following.
The deterministic evaluator, not you, decides whether a proposal is better.

Return this JSON shape:
{
  "analysis_summary": "short evidence-grounded diagnosis",
  "candidates": [
    {
      "hypothesis": "why this general change may help",
      "diagnosis": "failure pattern addressed",
      "target_failure_modes": ["general failure family"],
      "prompt": "complete replacement system prompt",
      "expected_effect": "measurable expected change"
    }
  ]
}
"""


def utc_now() -> str:
    """Return an explicit timestamp for the immutable proposal record."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _atomic_json(path: Path, value: Any) -> None:
    """Write one complete proposal artifact without exposing partial JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def _post_json(url: str, api_key: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    """Call the OpenAI-compatible DeepSeek chat completion endpoint.

    The credential is placed only in the request header. It is never included
    in the payload, returned value, exception text, or persisted artifacts.
    """
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        # The python.org macOS runtime does not automatically inherit the
        # system keychain certificate roots. Certifi provides the pinned CA
        # bundle already installed with the experiment environment.
        tls_context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # Preserve the provider status and a bounded response body for
        # diagnosis without ever echoing request headers or the API key.
        body = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"DeepSeek request failed with HTTP {error.code}: {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"DeepSeek request could not connect: {error.reason}") from error


def _validate_candidates(
    response: dict[str, Any],
    parent_prompt: str,
    count: int,
    maximum_added_words: int,
) -> list[dict[str, Any]]:
    """Reject malformed, duplicate, unchanged, or over-budget proposals."""
    candidates = response.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != count:
        raise ValueError(f"DeepSeek must return exactly {count} candidates")
    seen_prompts: set[str] = set()
    validated = []
    parent_words = len(parent_prompt.split())
    for index, item in enumerate(candidates, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"DeepSeek candidate {index} is not an object")
        prompt = " ".join(str(item.get("prompt") or "").split())
        if not prompt or prompt == " ".join(parent_prompt.split()):
            raise ValueError(f"DeepSeek candidate {index} did not change the prompt")
        if prompt in seen_prompts:
            raise ValueError(f"DeepSeek candidate {index} duplicates another proposal")
        added_words = len(prompt.split()) - parent_words
        if added_words > maximum_added_words:
            raise ValueError(
                f"DeepSeek candidate {index} adds {added_words} words, above the {maximum_added_words} word budget"
            )
        failure_modes = item.get("target_failure_modes")
        if not isinstance(failure_modes, list) or not failure_modes:
            raise ValueError(f"DeepSeek candidate {index} has no target failure modes")
        validated.append({
            "prompt": prompt,
            "hypothesis": str(item.get("hypothesis") or "").strip(),
            "diagnosis": str(item.get("diagnosis") or "").strip(),
            "target_failure_modes": [str(value) for value in failure_modes],
            "expected_effect": str(item.get("expected_effect") or "").strip(),
            "added_words": added_words,
        })
        seen_prompts.add(prompt)
    return validated


def propose(
    *,
    run_dir: Path,
    generation: int,
    parent_id: str,
    parent_prompt: str,
    candidate_count: int,
    maximum_added_words: int,
    failures: list[dict[str, Any]],
    history: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Request structured candidate prompts and persist full call provenance."""
    key_name = str(config.get("api_key_environment_variable") or "DEEPSEEK_API_KEY")
    api_key = os.environ.get(key_name)
    if not api_key:
        raise RuntimeError(f"{key_name} is required for the DeepSeek proposer")

    user_evidence = {
        "generation": generation,
        "parent_id": parent_id,
        "parent_prompt": parent_prompt,
        "candidate_count": candidate_count,
        "maximum_added_words_per_candidate": maximum_added_words,
        "selected_evolution_failures": failures[: int(config["selected_failures_per_generation"])],
        "prior_mutation_history": history[-int(config["maximum_history_records"]):],
    }
    payload = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {"role": "user", "content": "Produce the requested candidate set as JSON. Evidence:\n" + json.dumps(user_evidence, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": config["temperature"],
        "max_tokens": config["max_tokens"],
    }
    endpoint = str(config["base_url"]).rstrip("/") + "/chat/completions"
    started = time.monotonic()
    provider_response = _post_json(endpoint, api_key, payload, int(config["request_timeout_seconds"]))
    elapsed_seconds = time.monotonic() - started
    choices = provider_response.get("choices") or []
    content = choices[0].get("message", {}).get("content") if choices else None
    if not content:
        raise RuntimeError("DeepSeek returned no proposal content")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as error:
        raise RuntimeError("DeepSeek proposal content was not valid JSON") from error
    candidates = _validate_candidates(parsed, parent_prompt, candidate_count, maximum_added_words)

    # Store the exact evidence and response needed to audit the proposal. The
    # API key and HTTP headers are deliberately absent from this record.
    record = {
        "generation": generation,
        "parent_id": parent_id,
        "provider": config["provider"],
        "requested_model": config["model"],
        "returned_model": provider_response.get("model"),
        "system_fingerprint": provider_response.get("system_fingerprint"),
        "request_id": provider_response.get("id"),
        "created_at": utc_now(),
        "elapsed_seconds": elapsed_seconds,
        "usage": provider_response.get("usage", {}),
        "request_evidence": user_evidence,
        "request_sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
        "analysis_summary": str(parsed.get("analysis_summary") or ""),
        "candidates": candidates,
    }
    _atomic_json(run_dir / "proposals" / f"g{generation:02d}-deepseek.json", record)
    return record
