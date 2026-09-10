"""Checks on reading the site-wide voice settings out of Supabase.

The rule these all circle is that env is the floor, not the fallback of last
resort: a key that is absent, blank, or unreadable has to come back missing, so
the caller lands on whatever the server was started with. Returning "" instead
would pin the model to an empty string and the session would fail at the API
call, a long way from here.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app_settings  # noqa: E402


class env:
    """Temporarily set environment variables, restoring them afterwards."""

    def __init__(self, **values):
        self._values = values
        self._saved = {}

    def __enter__(self):
        for key, value in self._values.items():
            self._saved[key] = os.environ.get(key)
            os.environ[key] = value
        return self

    def __exit__(self, *exc):
        for key, old in self._saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        return False


def test_an_unconfigured_supabase_reads_as_no_settings():
    with env(SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        app_settings.invalidate_cache()
        assert asyncio.run(app_settings.fetch_voice_settings()) == {}
    app_settings.invalidate_cache()
    print("  ok: no Supabase means no settings, not an error")


def test_an_unedited_placeholder_key_counts_as_unset():
    """A `your_...` line copied out of env.example is a non-empty string that
    401s on every request, which would otherwise be invisible."""
    with env(SUPABASE_URL="https://example.supabase.co",
             SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"):
        assert app_settings.configured() is False
    print("  ok: a placeholder key is treated as unset")


def test_the_environment_is_read_lazily_not_at_import_time():
    """The regression that made the whole admin page a no-op.

    bot.py calls load_dotenv() in its module body, which runs *after* its own
    import block -- so a module-level `os.getenv("SUPABASE_URL")` here resolves
    before .env is loaded and comes back empty. configured() then returned
    False for the life of the process: every settings lookup failed open, the
    model chosen in the admin page was silently ignored, and nothing anywhere
    said so. Reading the environment at call time is what fixes it, so this
    test sets the variables *after* import and insists they are seen.
    """
    with env(SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        assert app_settings.configured() is False, "empty env should not look configured"
    with env(SUPABASE_URL="http://127.0.0.1:54321",
             SUPABASE_SERVICE_ROLE_KEY="a-real-looking-key"):
        assert app_settings.configured() is True, (
            "the environment was captured at import time, not read at call time"
        )
    print("  ok: env set after import is still seen")


def test_a_settings_row_is_read_out_of_the_response():
    rows = [{"value": {"llm_model": "google/gemini-flash-1.5", "provider_sort": "price"}}]
    parsed = app_settings.parse_rows(rows)
    assert parsed["llm_model"] == "google/gemini-flash-1.5"
    assert parsed["provider_sort"] == "price"
    print("  ok: a saved model comes back")


def test_a_blank_value_is_dropped_rather_than_returned():
    parsed = app_settings.parse_rows([{"value": {"llm_model": "   ", "provider_sort": "latency"}}])
    assert "llm_model" not in parsed, parsed
    assert parsed["provider_sort"] == "latency"
    print("  ok: a cleared field falls back to the environment")


def test_an_empty_or_malformed_row_reads_as_no_settings():
    for rows in ([], [{}], [{"value": None}], [{"value": "nonsense"}], None, {}):
        assert app_settings.parse_rows(rows) == {}, rows
    print("  ok: anything unexpected reads as no settings")


def test_the_seeded_empty_row_means_use_the_environment():
    """The migration seeds voice_stack as {} on purpose -- a deployment that
    never opens the admin page must behave exactly as it did before."""
    assert app_settings.parse_rows([{"value": {}}]) == {}
    print("  ok: the seeded row pins nothing")


def test_the_cache_is_served_until_it_is_invalidated():
    calls = []

    async def fake_read():
        calls.append(1)
        return {"llm_model": "openai/gpt-4o-mini"}

    saved = app_settings._read_settings
    app_settings._read_settings = fake_read
    try:
        app_settings.invalidate_cache()
        assert asyncio.run(app_settings.fetch_voice_settings())["llm_model"] == "openai/gpt-4o-mini"
        asyncio.run(app_settings.fetch_voice_settings())
        assert len(calls) == 1, f"read the database {len(calls)} times"

        # What /internal/settings_refresh does after the admin page saves.
        app_settings.invalidate_cache()
        asyncio.run(app_settings.fetch_voice_settings())
        assert len(calls) == 2, f"invalidating did not force a re-read ({len(calls)})"
    finally:
        app_settings._read_settings = saved
        app_settings.invalidate_cache()
    print("  ok: one read per TTL, and invalidating forces a fresh one")


def test_a_failed_read_is_cached_too_so_a_dead_database_is_not_hammered():
    calls = []

    async def failing_read():
        calls.append(1)
        return {}

    saved = app_settings._read_settings
    app_settings._read_settings = failing_read
    try:
        app_settings.invalidate_cache()
        asyncio.run(app_settings.fetch_voice_settings())
        asyncio.run(app_settings.fetch_voice_settings())
        assert len(calls) == 1, f"retried a failing read on every session ({len(calls)})"
    finally:
        app_settings._read_settings = saved
        app_settings.invalidate_cache()
    print("  ok: a failing read is not retried once per connection")


def main():
    tests = [
        test_an_unconfigured_supabase_reads_as_no_settings,
        test_an_unedited_placeholder_key_counts_as_unset,
        test_the_environment_is_read_lazily_not_at_import_time,
        test_a_settings_row_is_read_out_of_the_response,
        test_a_blank_value_is_dropped_rather_than_returned,
        test_an_empty_or_malformed_row_reads_as_no_settings,
        test_the_seeded_empty_row_means_use_the_environment,
        test_the_cache_is_served_until_it_is_invalidated,
        test_a_failed_read_is_cached_too_so_a_dead_database_is_not_hammered,
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
