"""STT provider registry."""

from __future__ import annotations

import importlib

from models._provider_loader import load_provider_factory, normalize_provider_name
from models.providers import get_provider_registry

STT_REGISTRY = get_provider_registry("stt")

# Trailing silence to flush into a recognizer that has no explicit "finish now",
# for providers that do not say what they need. See models/stt/azure.py.
DEFAULT_FLUSH_SILENCE_MS = 1500


def create_stt_service(provider_name: str, **kwargs):
    factory = load_provider_factory(STT_REGISTRY, provider_name, "STT")
    return factory(**kwargs)


def flush_silence_ms(provider_name: str) -> int:
    """How much silence ends a phrase for this provider.

    A streaming recognizer decides a phrase is over from silence in the audio,
    and a push-to-talk client stops sending audio the moment it commits -- so
    the turn is closed by writing that silence ourselves. How much is a property
    of the recognizer, so each provider module may declare its own; the ones
    that do not get a working default rather than a guess at the call site.
    """
    module_path = STT_REGISTRY.get(normalize_provider_name(provider_name))
    if not module_path:
        return DEFAULT_FLUSH_SILENCE_MS
    declared = getattr(importlib.import_module(module_path), "flush_silence_ms", None)
    return int(declared()) if callable(declared) else DEFAULT_FLUSH_SILENCE_MS
