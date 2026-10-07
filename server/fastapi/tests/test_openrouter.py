"""Checks on OpenRouter provider routing and reasoning effort.

These are the two extra_body fields the voice path sends that a stock
OpenRouterLLMService would not. A typo in either one hits every new session,
so they are whitelisted rather than passed through.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from openai import NOT_GIVEN  # noqa: E402

from models.llm import openrouter  # noqa: E402


class env:
    def __init__(self, **values):
        self._values = values
        self._saved = {}

    def __enter__(self):
        for key, value in self._values.items():
            self._saved[key] = os.environ.get(key)
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return self

    def __exit__(self, *exc):
        for key, old in self._saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        return False


def _params(service):
    return service.build_chat_completion_params(
        {
            "messages": [{"role": "user", "content": "hi"}],
            "tools": NOT_GIVEN,
            "tool_choice": NOT_GIVEN,
        }
    )


def _service(**kwargs):
    return openrouter.RoutedOpenRouterLLMService(
        api_key="test-key",
        settings=openrouter._settings(model="qwen/qwen3.8-27b"),
        **kwargs,
    )


def test_off_sends_enabled_false():
    assert openrouter.reasoning_body("none") == {"enabled": False, "effort": "none"}
    print("  ok: none turns thinking off")


def test_an_effort_hides_the_chain_of_thought():
    assert openrouter.reasoning_body("low") == {"effort": "low", "exclude": True}
    print("  ok: a thinking level is sent and excluded from the stream")


def test_unset_effort_omits_the_field():
    assert openrouter.reasoning_body(None) is None
    print("  ok: no effort means do not send reasoning")


def test_a_blank_or_missing_env_leaves_reasoning_unset():
    with env(OPENROUTER_REASONING_EFFORT=None):
        assert openrouter._reasoning_effort() is None
    with env(OPENROUTER_REASONING_EFFORT="  "):
        assert openrouter._reasoning_effort() is None
    print("  ok: blank env does not invent an effort")


def test_admin_override_beats_the_environment():
    with env(OPENROUTER_REASONING_EFFORT="xhigh"):
        assert openrouter._reasoning_effort("low") == "low"
        assert openrouter._reasoning_effort() == "xhigh"
    print("  ok: the admin page wins over env")


def test_an_unknown_effort_raises_rather_than_falling_back():
    try:
        openrouter._reasoning_effort("think-hard")
    except RuntimeError as exc:
        assert "must be one of" in str(exc)
        print("  ok: a typo raises")
        return
    raise AssertionError("an unknown effort was accepted")


def test_chat_params_include_reasoning_and_provider_sort():
    service = _service(provider_sort="price", reasoning_effort="low")
    extra = _params(service)["extra_body"]
    assert extra["provider"]["sort"] == "price"
    assert extra["reasoning"] == {"effort": "low", "exclude": True}
    print("  ok: both extras land on the request")


def test_nitro_still_sends_reasoning():
    """Nitro used to return before extra_body was written, which would have
    silently dropped a thinking setting the admin page had just saved."""
    service = _service(provider_sort="nitro", reasoning_effort="none")
    params = _params(service)
    assert params["model"] == "qwen/qwen3.8-27b:nitro"
    assert params["extra_body"]["reasoning"] == {"enabled": False, "effort": "none"}
    assert "provider" not in params["extra_body"]
    print("  ok: nitro keeps reasoning and skips provider.sort")


def test_no_reasoning_omits_the_key_entirely():
    service = _service(provider_sort="latency")
    extra = _params(service)["extra_body"]
    assert "reasoning" not in extra
    assert extra["provider"]["sort"] == "latency"
    print("  ok: unset reasoning is omitted, not sent as null")


def test_listed_providers_are_the_only_ones_used():
    """With fallbacks on, a rate-limited listed host hands the request to any
    other host -- measured 2026-10-07: order=[deepinfra] was served by Relace."""
    service = _service(provider_sort="latency", provider_order=["groq", "akashml"])
    extra = _params(service)["extra_body"]
    assert extra["provider"]["sort"] == "latency"
    assert extra["provider"]["order"] == ["groq", "akashml"]
    assert extra["provider"]["allow_fallbacks"] is False
    print("  ok: listed hosts are sent as a strict provider.order")


def test_no_order_keeps_fallbacks():
    service = _service(provider_sort="latency")
    assert "allow_fallbacks" not in _params(service)["extra_body"]["provider"]
    print("  ok: without a list, any host may serve")


def test_nitro_still_sends_provider_order():
    service = _service(provider_sort="nitro", provider_order=["groq"])
    params = _params(service)
    assert params["model"] == "qwen/qwen3.8-27b:nitro"
    assert params["extra_body"]["provider"] == {"order": ["groq"], "allow_fallbacks": False}
    print("  ok: nitro keeps the listed hosts and skips provider.sort")


def test_an_unknown_provider_slug_raises():
    try:
        openrouter._provider_order(["groq", "not a host"])
    except RuntimeError as exc:
        assert "unknown slug" in str(exc)
        print("  ok: a junk slug raises")
        return
    raise AssertionError("a junk slug was accepted")


def test_env_provider_order_is_a_comma_list():
    with env(OPENROUTER_PROVIDER_ORDER=" Groq, akashml, groq "):
        assert openrouter._provider_order() == ["groq", "akashml"]
    with env(OPENROUTER_PROVIDER_ORDER=None):
        assert openrouter._provider_order() is None
    print("  ok: env order is comma-separated and de-duplicated")


def main():
    tests = [
        test_off_sends_enabled_false,
        test_an_effort_hides_the_chain_of_thought,
        test_unset_effort_omits_the_field,
        test_a_blank_or_missing_env_leaves_reasoning_unset,
        test_admin_override_beats_the_environment,
        test_an_unknown_effort_raises_rather_than_falling_back,
        test_chat_params_include_reasoning_and_provider_sort,
        test_nitro_still_sends_reasoning,
        test_no_reasoning_omits_the_key_entirely,
        test_listed_providers_are_the_only_ones_used,
        test_no_order_keeps_fallbacks,
        test_nitro_still_sends_provider_order,
        test_an_unknown_provider_slug_raises,
        test_env_provider_order_is_a_comma_list,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            test()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
        except Exception as exc:
            failed += 1
            import traceback

            print(f"  ERROR: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(main())
