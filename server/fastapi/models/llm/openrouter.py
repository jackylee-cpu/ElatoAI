"""OpenRouter LLM provider."""

from __future__ import annotations

import inspect
import os
import re

from pipecat.adapters.services.open_ai_adapter import OpenAILLMInvocationParams
from pipecat.services.openrouter.llm import OpenRouterLLMService

_VALID_SORTS = {"latency", "throughput", "price", "nitro"}
# Mirrors OpenRouter's reasoning.effort. "none" turns thinking off on models
# that allow it; gpt-oss rejects that and needs low instead.
_VALID_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}
_PROVIDER_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")
_MAX_PREFERRED_PROVIDERS = 12


class RoutedOpenRouterLLMService(OpenRouterLLMService):
    """OpenRouter LLM with explicit provider routing for speed or price."""

    def __init__(
        self,
        *args,
        provider_sort: str = "latency",
        provider_order: list[str] | None = None,
        reasoning_effort: str | None = None,
        **kwargs,
    ):
        self._provider_sort = provider_sort
        self._provider_order = provider_order
        self._reasoning_effort = reasoning_effort
        super().__init__(*args, **kwargs)

    def build_chat_completion_params(self, params_from_context: OpenAILLMInvocationParams) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        extra_body = dict(params.get("extra_body") or {})
        provider = dict(extra_body.get("provider") or {})

        if self._provider_sort == "nitro":
            model = params.get("model")
            if isinstance(model, str) and model and not model.endswith(":nitro"):
                params["model"] = f"{model}:nitro"
        else:
            provider["sort"] = self._provider_sort

        if self._provider_order:
            provider["order"] = list(self._provider_order)

        if provider:
            extra_body["provider"] = provider

        reasoning = reasoning_body(self._reasoning_effort)
        if reasoning:
            extra_body["reasoning"] = reasoning

        if extra_body:
            params["extra_body"] = extra_body
        return params


def _settings(**values):
    params = inspect.signature(OpenRouterLLMService.Settings).parameters
    return OpenRouterLLMService.Settings(
        **{key: value for key, value in values.items() if value is not None and key in params}
    )


def _provider_sort(override: str | None = None) -> str:
    """Routing preference, from the admin page if set, else from the environment.

    An override arrives from the `app_settings` row, which is typed into a web
    form rather than reviewed at deploy time, so it goes through the same
    whitelist as the env var. A bad value raising here is deliberate: routing
    silently falling back to "latency" when someone asked for "price" is the
    kind of thing nobody notices until the bill arrives.
    """
    sort = (override or os.getenv("OPENROUTER_PROVIDER_SORT") or "latency").strip().lower()
    if sort not in _VALID_SORTS:
        raise RuntimeError(
            "OpenRouter provider sort must be one of: latency, throughput, price, nitro"
        )
    return sort


def _provider_order(override: list[str] | str | None = None) -> list[str] | None:
    """Preferred OpenRouter hosts, tried first and in this order.

    Same whitelist rule as provider sort: a junk slug 404s the request with
    "No endpoints found for the request with manual order". Empty means omit
    the field and let `sort` pick.
    """
    if override is None:
        raw = os.getenv("OPENROUTER_PROVIDER_ORDER")
        names = raw.split(",") if raw else []
    elif isinstance(override, str):
        names = override.split(",")
    else:
        names = list(override)

    slugs: list[str] = []
    seen: set[str] = set()
    for name in names:
        slug = name.strip().lower()
        if not slug or slug in seen:
            continue
        if not _PROVIDER_SLUG.match(slug):
            raise RuntimeError(f"OpenRouter provider order has an unknown slug: {slug}")
        seen.add(slug)
        slugs.append(slug)
        if len(slugs) >= _MAX_PREFERRED_PROVIDERS:
            break
    return slugs or None


def _reasoning_effort(override: str | None = None) -> str | None:
    """How hard the model should think, or None to leave OpenRouter's default.

    Same whitelist rule as provider sort: a typo here would otherwise land on
    every new session as whatever the model felt like that day. An absent
    value is different -- it means "do not send the field", so Gemma stays
    off, Qwen stays on, and gpt-oss keeps its mandatory medium.
    """
    raw = override if override is not None else os.getenv("OPENROUTER_REASONING_EFFORT")
    if raw is None:
        return None
    effort = raw.strip().lower()
    if not effort:
        return None
    if effort not in _VALID_EFFORTS:
        raise RuntimeError(
            "OpenRouter reasoning effort must be one of: none, minimal, low, medium, high, xhigh"
        )
    return effort


def reasoning_body(effort: str | None) -> dict | None:
    """The OpenRouter `reasoning` object, or None when the field should be omitted."""
    if not effort:
        return None
    if effort == "none":
        return {"enabled": False, "effort": "none"}
    # Hide the chain of thought from the stream. Voice TTS only wants the
    # spoken answer; the model still thinks internally at this effort.
    return {"effort": effort, "exclude": True}


def create_service(**kwargs):
    api_key = kwargs.get("api_key") or os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OpenRouter LLM requires OPENROUTER_API_KEY")

    return RoutedOpenRouterLLMService(
        api_key=api_key,
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        provider_sort=_provider_sort(kwargs.get("provider_sort")),
        provider_order=_provider_order(kwargs.get("provider_order")),
        reasoning_effort=_reasoning_effort(kwargs.get("reasoning_effort")),
        settings=_settings(
            model=kwargs.get("model") or os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini",
            system_instruction=kwargs.get("system_instruction"),
            temperature=kwargs.get("temperature"),
        ),
    )
