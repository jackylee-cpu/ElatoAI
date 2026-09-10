"""OpenRouter LLM provider."""

from __future__ import annotations

import inspect
import os

from pipecat.adapters.services.open_ai_adapter import OpenAILLMInvocationParams
from pipecat.services.openrouter.llm import OpenRouterLLMService

_VALID_SORTS = {"latency", "throughput", "price", "nitro"}


class RoutedOpenRouterLLMService(OpenRouterLLMService):
    """OpenRouter LLM with explicit provider routing for speed or price."""

    def __init__(self, *args, provider_sort: str = "latency", **kwargs):
        self._provider_sort = provider_sort
        super().__init__(*args, **kwargs)

    def build_chat_completion_params(self, params_from_context: OpenAILLMInvocationParams) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        if self._provider_sort == "nitro":
            model = params.get("model")
            if isinstance(model, str) and model and not model.endswith(":nitro"):
                params["model"] = f"{model}:nitro"
            return params

        extra_body = dict(params.get("extra_body") or {})
        provider = dict(extra_body.get("provider") or {})
        provider["sort"] = self._provider_sort
        extra_body["provider"] = provider
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


def create_service(**kwargs):
    api_key = kwargs.get("api_key") or os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OpenRouter LLM requires OPENROUTER_API_KEY")

    return RoutedOpenRouterLLMService(
        api_key=api_key,
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        provider_sort=_provider_sort(kwargs.get("provider_sort")),
        settings=_settings(
            model=kwargs.get("model") or os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini",
            system_instruction=kwargs.get("system_instruction"),
            temperature=kwargs.get("temperature"),
        ),
    )
