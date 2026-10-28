# SPDX-License-Identifier: Apache-2.0
"""macOS `say` as a TTS engine (omlx/utils/macos_say.py) and its settings.

The probes shell out to macOS-only tooling (`say -v ?`, osascript,
`defaults read`), so every test here feeds canned probe output instead: the
suite runs on any machine, and a Linux CI still proves the parsing, the
routing chain and the endpoint contract. Nothing here calls a system binary.
"""

import asyncio
import json

import pytest
from fastapi import HTTPException

from omlx.utils import macos_say as ms

SAY_ROSTER = """\
Zuzana               cs_CZ    # Ahoj! Já jsem Zuzana.
Iveta                cs_CZ    # Dobrý den, já jsem Iveta.
Samantha (English (US)) en_US # Hello! My name is Samantha.
Daniel (English (UK)) en_GB   # Hello, my name is Daniel.
junk line without a locale
"""

AV_ROWS = """\
Zuzana\tcs-CZ\tcom.apple.voice.premium.cs-CZ.Zuzana\tAVSpeechSynthesisVoice Quality: Premium\t0
Zuzana\tcs-CZ\tcom.apple.voice.super-compact.cs-CZ.Zuzana\tAVSpeechSynthesisVoice Quality: Default\t1
Laura\tsk-SK\tcom.apple.voice.compact.sk-SK.Laura\tAVSpeechSynthesisVoice Quality: Default\t1
Samantha\ten-US\tcom.apple.voice.compact.en-US.Samantha\tAVSpeechSynthesisVoice Quality: Default\t1
"""

# `defaults read com.apple.Accessibility SpokenContentDefaultVoiceSelectionsByLanguage`
SPKEN = """(\n    cs,\n    {\n        boundLanguage = cs;\n        voiceId = "com.apple.voice.premium.cs-CZ.Zuzana";\n    }\n)"""

INSTALLED = [
    {
        "name": "Zuzana (Premium)",
        "locale": "cs-CZ",
        "quality": "premium",
        "sample": "Ahoj",
        "identifier": "com.apple.voice.premium.cs-CZ.Zuzana",
        "installed": True,
        "default": False,
        "downloaded": True,
    },
    {
        "name": "Zuzana",
        "locale": "cs-CZ",
        "quality": "standard",
        "sample": "Ahoj",
        "identifier": "com.apple.voice.super-compact.cs-CZ.Zuzana",
        "installed": True,
        "default": True,
        "downloaded": False,
    },
    {
        "name": "Laura",
        "locale": "sk-SK",
        "quality": "standard",
        "sample": "Ahoj",
        "identifier": "com.apple.voice.compact.sk-SK.Laura",
        "installed": True,
        "default": True,
        "downloaded": False,
    },
    {
        "name": "Samantha",
        "locale": "en-US",
        "quality": "standard",
        "sample": "Hello",
        "identifier": "com.apple.voice.compact.en-US.Samantha",
        "installed": True,
        "default": True,
        "downloaded": False,
    },
    {
        "name": "Not On This Mac",
        "locale": "de-DE",
        "quality": "premium",
        "sample": "",
        "identifier": "",
        "installed": False,
        "default": False,
        "downloaded": False,
    },
]


@pytest.fixture
def mac(monkeypatch):
    """A Mac with INSTALLED as its roster and nothing selected in System
    Settings - tests add picks from here."""
    monkeypatch.setattr(ms, "available", lambda: True)
    monkeypatch.setattr(ms, "list_voices", lambda force=False: list(INSTALLED))
    monkeypatch.setattr(ms, "spoken_selections", lambda force=False: {})
    monkeypatch.setattr(ms, "selected_voice_identifier", lambda force=False: "")
    monkeypatch.setattr(ms, "system_language", lambda force=False: "en-US")
    monkeypatch.setattr(ms, "detect_language", lambda text: "")
    return ms


# ---------------------------------------------------------------- parsing --


def test_parse_voices_keeps_names_with_spaces_and_parentheses():
    rows = ms.parse_voices(SAY_ROSTER)
    assert [r["name"] for r in rows] == [
        "Zuzana",
        "Iveta",
        "Samantha (English (US))",
        "Daniel (English (UK))",
    ]
    assert rows[0]["locale"] == "cs-CZ"  # say writes cs_CZ; one spelling out
    assert rows[0]["sample"].startswith("Ahoj")
    assert rows[2]["quality"] == "standard"


def test_parse_voices_reads_quality_tiers_from_the_name():
    rows = ms.parse_voices("Ava (Premium) en_US # Hi\nAva (Enhanced) en-US # Hi\n")
    assert [r["quality"] for r in rows] == ["premium", "enhanced"]


def test_parse_av_reads_identifier_and_flag():
    rows = ms.parse_av(AV_ROWS)
    assert rows[0]["identifier"] == "com.apple.voice.premium.cs-CZ.Zuzana"
    assert rows[0]["quality"] == "premium"
    assert rows[1]["quality"] == "standard"  # 'Default' is the plain tier
    assert rows[1]["default"] is True
    assert ms.parse_av("garbage") == []


def test_parse_av_accepts_probe_output_without_the_default_column():
    row = ms.parse_av("X\ten-US\tid.x\tAVSpeechSynthesisVoice Quality: Enhanced")[0]
    assert row["quality"] == "enhanced" and row["default"] is False


def test_parse_catalog_reads_footprints_and_multiple_languages():
    doc = {
        "Assets": [
            {"Name": "Zuzana", "Footprint": "premium", "Languages": ["cs-CZ"]},
            {"Name": "Iveta", "Footprint": "compact", "Language": "cs-CZ"},
            {"Name": "Junk"},
        ]
    }
    rows = ms.parse_catalog(doc, "footprint")
    assert {(r["name"], r["quality"]) for r in rows} == {
        ("Zuzana", "premium"),
        ("Iveta", "standard"),
    }


def test_parse_spoken_selections_reads_the_alternating_array():
    assert ms._parse_spoken_selections(SPKEN) == {
        "cs": "com.apple.voice.premium.cs-CZ.Zuzana"
    }
    assert ms._parse_spoken_selections("") == {}
    assert ms._parse_spoken_selections("{ nope = 1; }") == {}


# ------------------------------------------------------------- locale math --


@pytest.mark.parametrize(
    "requested,have,expected",
    [
        ("cs-CZ", "cs-CZ", 2),
        ("cs", "cs-CZ", 1),
        ("cs-CZ", "cs", 1),
        ("cs-CZ", "cs-SK", 0),
        ("en-US", "en-GB", 0),
        ("", "cs-CZ", 0),
    ],
)
def test_locale_score(requested, have, expected):
    assert ms.locale_score(requested, have) == expected


def test_split_model_token_and_locale_test():
    assert ms.split_model_token("say") == (True, "")
    assert ms.split_model_token("SAY:Zuzana") == (True, "Zuzana")
    assert ms.split_model_token("say:cs-CZ") == (True, "cs-CZ")
    assert ms.split_model_token("say:") == (True, "")
    assert ms.split_model_token("kokoro") == (False, "")
    assert ms.split_model_token("") == (False, "")
    assert ms.looks_like_locale("zh-Hans") and not ms.looks_like_locale("Zuzana")


# ---------------------------------------------------------------- routing --


def test_language_prefers_the_configured_voice(mac):
    picked = ms.language_voice(
        "cs-CZ", {"cs-CZ": "com.apple.voice.super-compact.cs-CZ.Zuzana"}
    )
    assert picked["identifier"] == "com.apple.voice.super-compact.cs-CZ.Zuzana"


def test_configuration_for_another_language_never_answers(mac):
    assert ms.route(language="sk-SK", voices={"cs-CZ": "Laura"}) == (
        "com.apple.voice.compact.sk-SK.Laura"
    )


def test_stale_configuration_falls_back_to_the_system_chain(mac, monkeypatch):
    monkeypatch.setattr(
        ms,
        "system_selected_voice",
        lambda lang: next(v for v in INSTALLED if v["locale"] == "cs-CZ"),
    )
    got = ms.route(language="cs-CZ", voices={"cs-CZ": "Voice Deleted Yesterday"})
    assert got == "com.apple.voice.premium.cs-CZ.Zuzana"


def test_system_settings_pick_beats_the_factory_flag(mac, monkeypatch):
    # cs has a real Spoken Content selection (a compact voice, i.e. a LOWER
    # tier than the installed Premium row); sk only has the AV default flag.
    monkeypatch.setattr(
        ms,
        "spoken_selections",
        lambda force=False: {"cs": "com.apple.voice.super-compact.cs-CZ.Zuzana"},
    )
    assert ms.system_selected_voice("cs-CZ")["identifier"] == (
        "com.apple.voice.super-compact.cs-CZ.Zuzana"
    )
    assert ms.route(language="cs-CZ") == (
        "com.apple.voice.super-compact.cs-CZ.Zuzana"
    )
    # 'sk' was never picked: nothing answers it, so its own chain goes on.
    assert ms.system_selected_voice("sk-SK") is None
    assert ms.route(language="sk-SK") == "com.apple.voice.compact.sk-SK.Laura"


def test_region_specific_spoken_pick_does_not_claim_the_whole_family(mac, monkeypatch):
    monkeypatch.setattr(
        ms, "spoken_selections", lambda force=False: {"en-US": "com.apple.voice.compact.en-US.Samantha"}
    )
    assert ms.system_selected_voice("en-US") is not None
    # An 'en-US' selection never speaks for en-GB: 'en-GB' has nothing here.
    assert ms.system_selected_voice("en-GB") is None


def test_selected_system_voice_answers_only_its_own_language(mac, monkeypatch):
    monkeypatch.setattr(
        ms,
        "selected_row",
        lambda: next(v for v in INSTALLED if v["locale"] == "en-US"),
    )
    assert ms.route(language="en-US") == "com.apple.voice.compact.en-US.Samantha"
    # cs-CZ has voices installed but no selection of its own: the language's
    # own flagged default answers (step 4), before its best tier - and it is
    # never the English voice of a different language.
    assert ms.route(language="cs-CZ") == (
        "com.apple.voice.super-compact.cs-CZ.Zuzana"
    )


def test_best_tier_answers_only_when_the_language_has_no_flagged_row(mac, monkeypatch):
    rows = [dict(v, default=False) for v in INSTALLED if v["locale"] == "cs-CZ"]
    rest = [v for v in INSTALLED if v["locale"] != "cs-CZ"]
    monkeypatch.setattr(ms, "list_voices", lambda force=False: rows + rest)
    assert ms.route(language="cs-CZ") == "com.apple.voice.premium.cs-CZ.Zuzana"


def test_language_with_nothing_installed_fails_instead_of_guessing(mac):
    with pytest.raises(LookupError):
        ms.route(language="de-DE")
    with pytest.raises(LookupError):
        ms.route(voice="Definitely Not Here")


def test_language_less_request_asks_macos_and_then_routes(mac, monkeypatch):
    monkeypatch.setattr(ms, "detect_language", lambda text: "cs")
    assert ms.route(text="Ahoj, jak se máš?") == (
        "com.apple.voice.super-compact.cs-CZ.Zuzana"
    )


def test_unanswered_detection_falls_back_to_the_macs_default(mac, monkeypatch):
    # Detection says 'de' and nothing German is installed: a guess must never
    # be WORSE than no guess, so routing keeps the Mac's own default voice
    # instead of failing or speaking German with a Czech voice.
    monkeypatch.setattr(ms, "detect_language", lambda text: "de")
    assert ms.route(text="Hallo") == "com.apple.voice.compact.en-US.Samantha"


def test_route_returns_empty_when_nothing_can_be_named(mac, monkeypatch):
    monkeypatch.setattr(ms, "default_voice", lambda: None)
    assert ms.route(text="hello") == ""


def test_explicit_voice_wins_over_language_and_configuration(mac):
    got = ms.route(
        voice="Laura",
        language="cs-CZ",
        voices={"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"},
    )
    assert got == "com.apple.voice.compact.sk-SK.Laura"


def test_locale_named_as_voice_routes_like_a_language(mac):
    assert ms.route(voice="sk") == "com.apple.voice.compact.sk-SK.Laura"


def test_language_options_labels_the_detectable_default_only(mac):
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        ms,
        "system_selected_voice",
        lambda lang: next(
            (v for v in INSTALLED if v["locale"] == lang), None
        )
        if lang == "cs-CZ"
        else None,
    )
    options = ms.language_options({"en-US": "com.apple.voice.compact.en-US.Samantha"})
    by_locale = {o["locale"]: o for o in options}
    cs = by_locale["cs-CZ"]
    assert cs["default"] == {
        "name": "Zuzana (Premium)",
        "locale": "cs-CZ",
        "preference": True,
    }
    # sk-SK has no user pick: the label must stay unnamed, not claim a voice.
    assert by_locale["sk-SK"]["default"] == {
        "name": "",
        "locale": "",
        "preference": False,
    }
    # a downloadable-but-absent voice is not offered
    assert "de-DE" not in by_locale
    assert by_locale["en-US"]["configured"] == (
        "com.apple.voice.compact.en-US.Samantha"
    )
    assert [v["quality"] for v in cs["voices"]] == ["premium", "standard"]
    monkeypatch.undo()


def test_effective_rows_exclude_downloadable_voices(mac):
    assert all(v["installed"] for v in ms.installed_rows())


# ----------------------------------------------------------- persistence --


def test_integration_settings_round_trip_the_speech_fields():
    from omlx.settings import IntegrationSettings

    s = IntegrationSettings(
        say_enabled=False,
        say_voices={"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"},
        say_long_input="reject",
    )
    stored = json.loads(json.dumps(s.to_dict()))
    back = IntegrationSettings.from_dict(stored)
    assert back.say_enabled is False
    assert back.say_voices == {"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"}
    assert back.say_long_input == "reject"


def test_speech_settings_default_to_enabled_with_no_overrides():
    from omlx.settings import IntegrationSettings

    s = IntegrationSettings.from_dict({})
    assert s.say_enabled is True
    assert s.say_voices == {}
    assert s.say_long_input == "speak"


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, "speak"),
        ("", "speak"),
        ("speak", "speak"),
        ("REJECT", "reject"),
        ("  reject ", "reject"),
        ("split", "speak"),  # not a policy this engine offers
        (7, "speak"),
    ],
)
def test_clean_say_long_input_falls_back_to_speaking(raw, expected):
    from omlx.settings import _clean_say_long_input

    assert _clean_say_long_input(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, {}),
        ("nonsense", {}),
        ([{"cs": "x"}], {}),
        ({"cs_CZ": "Voice"}, {"cs-CZ": "Voice"}),
        ({"cs-CZ": "", "en-US": "Samantha"}, {"en-US": "Samantha"}),
        ({"cs-CZ": 7}, {}),
    ],
)
def test_clean_say_voices_rejects_junk(raw, expected):
    from omlx.settings import _clean_say_voices

    assert _clean_say_voices(raw) == expected


def test_clean_voices_drops_addresses_this_mac_cannot_speak(mac):
    assert ms.clean_voices(
        {
            "cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana",
            "sk-SK": "Voice That Is Gone",
            "": "whatever",
        }
    ) == {"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"}


# ---------------------------------------------------------- synthesis argv --


class FakeProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_synth_addresses_say_through_argv_with_a_temp_file(mac, monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, capture_output, text, timeout):
        calls.append(list(cmd))
        # `say` writes the file named by -o
        out = cmd[cmd.index("-o") + 1]
        with open(out, "wb") as fh:
            fh.write(b"RIFF" + b"\0" * 500)
        return FakeProcess(stdout="ok")

    monkeypatch.setattr(ms.subprocess, "run", fake_run)
    monkeypatch.setattr(ms.tempfile, "TemporaryDirectory", _dir_context(tmp_path))

    wav = ms.synth_bytes(
        "Ahoj, jak se máš?",
        language="cs-CZ",
        voices={"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"},
        speed=1.5,
    )
    assert wav.startswith(b"RIFF")
    cmd = calls[0]
    assert cmd[0] == "say"
    assert cmd[cmd.index("-v") + 1] == "com.apple.voice.premium.cs-CZ.Zuzana"
    assert cmd[cmd.index("-r") + 1] == str(round(175 * 1.5))
    assert cmd[cmd.index("-f") + 1].endswith("in.txt")
    assert "--data-format=LEI16@24000" in cmd
    assert not any("&&" in part or ";" in part or " " in part for part in cmd[1:2])


def test_synth_drops_the_voice_flag_when_macos_should_choose(mac, monkeypatch, tmp_path):
    # Nothing nameable: no selection, no system language, no flagged row. The
    # utterance still speaks - with the voice `say` itself picks.
    monkeypatch.setattr(ms, "default_voice", lambda: None)
    monkeypatch.setattr(ms, "system_language", lambda force=False: "")
    calls = []

    def fake_run(cmd, capture_output, text, timeout):
        calls.append(list(cmd))
        with open(cmd[cmd.index("-o") + 1], "wb") as fh:
            fh.write(b"RIFF" + b"\0" * 500)
        return FakeProcess()

    monkeypatch.setattr(ms.subprocess, "run", fake_run)
    monkeypatch.setattr(ms.tempfile, "TemporaryDirectory", _dir_context(tmp_path))

    ms.synth_bytes("Hello there, friend of mine")
    assert "-v" not in calls[0]


def test_synth_reports_a_failure_instead_of_returning_silence(mac, monkeypatch, tmp_path):
    def fake_run(cmd, capture_output, text, timeout):
        return FakeProcess(returncode=1, stderr="unknown voice")

    monkeypatch.setattr(ms.subprocess, "run", fake_run)
    monkeypatch.setattr(ms.tempfile, "TemporaryDirectory", _dir_context(tmp_path))
    with pytest.raises(RuntimeError, match="unknown voice"):
        ms.synth_bytes("Hello", voice="Laura")


def _capture_say_run(ms, monkeypatch, tmp_path, calls):
    def fake_run(cmd, capture_output, text, timeout):
        with open(cmd[cmd.index("-f") + 1], encoding="utf-8") as fh:
            calls.append(len(fh.read()))
        with open(cmd[cmd.index("-o") + 1], "wb") as fh:
            fh.write(b"RIFF" + b"\0" * 500)
        return FakeProcess()

    monkeypatch.setattr(ms.subprocess, "run", fake_run)
    monkeypatch.setattr(ms.tempfile, "TemporaryDirectory", _dir_context(tmp_path))


def test_long_text_is_said_whole_and_in_one_call(mac, monkeypatch, tmp_path):
    # Past the OpenAI limit the operator's policy decides, and the default
    # says everything. One `say` call renders the whole utterance: measured on
    # a Mac, 8.3k characters (7.5 minutes of audio) take 7 s of wall time,
    # while splitting the same text costs ~0.9 s of CPU per extra call and
    # returns the identical bytes. Nothing is dropped on the floor either -
    # silently truncating a reply is worse than either policy.
    calls = []
    _capture_say_run(ms, monkeypatch, tmp_path, calls)
    ms.synth_bytes("a" * ms.MAX_SAY_CHARS)
    assert calls == [ms.MAX_SAY_CHARS]


def test_reject_policy_refuses_before_spawning_anything(mac, monkeypatch, tmp_path):
    calls = []
    _capture_say_run(ms, monkeypatch, tmp_path, calls)
    with pytest.raises(ValueError, match="4096"):
        ms.synth_bytes("a" * (ms.OPENAI_INPUT_CHARS + 1), long_input="reject")
    assert calls == []
    # Text inside the limit speaks normally under the same policy.
    ms.synth_bytes("a" * ms.OPENAI_INPUT_CHARS, long_input="reject")
    assert calls == [ms.OPENAI_INPUT_CHARS]


@pytest.mark.parametrize("policy", ms.LONG_INPUT_POLICIES)
def test_both_policies_refuse_past_the_ceiling(mac, policy):
    with pytest.raises(ValueError, match=str(ms.MAX_SAY_CHARS)):
        ms.synth_bytes("a" * (ms.MAX_SAY_CHARS + 1), long_input=policy)


@pytest.mark.parametrize(
    "length,policy,expected",
    [
        (100, "speak", None),
        (ms.OPENAI_INPUT_CHARS, "reject", None),
        (ms.OPENAI_INPUT_CHARS + 1, "speak", None),
        (ms.OPENAI_INPUT_CHARS + 1, "junk", None),  # junk reads as the default
        (ms.OPENAI_INPUT_CHARS + 1, "reject", "4096"),
        (ms.MAX_SAY_CHARS + 1, "speak", str(ms.MAX_SAY_CHARS)),
    ],
)
def test_long_input_policy_matrix(length, policy, expected):
    refused = ms.long_input_error(length, policy)
    assert (expected in refused) if expected else refused is None


def test_empty_text_is_a_value_error_not_silence(mac):
    with pytest.raises(ValueError):
        ms.synth_bytes("   ")


def test_speed_junk_keeps_the_engine_default(mac):
    assert ms._speed_wpm("nonsense") is None
    assert ms._speed_wpm(0) is None
    assert ms._speed_wpm(None) is None
    assert ms._speed_wpm(1) == "175"
    assert ms._speed_wpm(99) == "450"  # clamped: no chipmunk requests


def _dir_context(tmp_path):
    import contextlib

    @contextlib.contextmanager
    def _ctx(*args, **kwargs):
        yield str(tmp_path)

    return _ctx


# ------------------------------------------------------------------ probes --


def test_probes_degrade_to_empty_answers_off_macos(monkeypatch):
    monkeypatch.setattr(ms, "available", lambda: False)
    monkeypatch.setattr(ms, "_run_osascript", lambda *a, **k: "")
    assert ms.list_voices(force=True) == []
    assert ms.spoken_selections(force=True) == {}
    assert ms.selected_voice_identifier(force=True) == ""
    assert ms.route(text="hello") == ""


def test_run_osascript_swallows_a_failing_probe(monkeypatch):
    monkeypatch.setattr(ms.shutil, "which", lambda name: "/usr/bin/osascript")

    def boom(*args, **kwargs):
        raise OSError("no osascript")

    monkeypatch.setattr(ms.subprocess, "run", boom)
    assert ms._run_osascript("anything") == ""


def test_detect_language_rejects_low_confidence_and_und(monkeypatch):
    monkeypatch.setattr(ms, "available", lambda: True)
    monkeypatch.setattr(ms, "_run_osascript", lambda script, arg=None, timeout=30: "pl\t29")
    assert ms.detect_language("ok") == ""
    monkeypatch.setattr(ms, "_run_osascript", lambda script, arg=None, timeout=30: "und\t55")
    assert ms.detect_language("asdf") == ""
    monkeypatch.setattr(ms, "_run_osascript", lambda script, arg=None, timeout=30: "zh-Hans\t99")
    assert ms.detect_language("你好，今天过得怎么样？") == "zh"
    monkeypatch.setattr(ms, "_run_osascript", lambda script, arg=None, timeout=30: "cs\t99")
    assert ms.detect_language("Ahoj") == "cs"
    assert ms.detect_language("no") == ""  # below the minimum length


# ---------------------------------------------------------------- endpoint --


def test_say_model_token_never_reaches_the_engine_pool():
    from omlx.api import audio_routes as ar

    assert ar._say_engine_request("say") == (True, "")
    assert ar._say_engine_request("say:Zuzana") == (True, "Zuzana")
    assert ar._say_engine_request("Kokoro") == (False, "")


def test_registered_model_named_say_keeps_its_name(monkeypatch):
    from omlx.api import audio_routes as ar
    from omlx import server as server_mod

    class Pool:
        def get_model_ids(self):
            return ["Kokoro", "say"]

    monkeypatch.setattr(server_mod._server_state, "engine_pool", Pool(), raising=False)
    assert ar._say_engine_request("say") == (False, "")
    assert ar._say_engine_request("say:Zuzana") == (True, "Zuzana")


def _speech_request(**kwargs):
    from omlx.api.audio_models import AudioSpeechRequest

    base = {"model": "say", "input": "Hello there, this is a test."}
    base.update(kwargs)
    return AudioSpeechRequest(**base)


@pytest.fixture
def say_endpoint(monkeypatch):
    from omlx.api import audio_routes as ar
    from omlx.utils import macos_say as engine

    monkeypatch.setattr(engine, "available", lambda: True)
    monkeypatch.setattr(engine, "resolve", lambda name: None)
    monkeypatch.setattr(
        ar, "_macos_say_settings", lambda: (True, {"cs-CZ": "Zuzana"}, "speak")
    )
    calls = {}

    def fake_synth(text, voice, language, voices, speed, long_input):
        calls["voice"] = voice
        calls["language"] = language
        calls["voices"] = voices
        calls["long_input"] = long_input
        return b"RIFF" + b"\0" * 500

    monkeypatch.setattr(engine, "synth_bytes", fake_synth)
    return ar, calls


def test_speech_serves_the_macos_engine(monkeypatch, say_endpoint):
    ar, calls = say_endpoint
    response = asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert response.body.startswith(b"RIFF")
    assert response.media_type == "audio/wav"
    assert calls["voices"] == {"cs-CZ": "Zuzana"}


def test_speech_passes_the_long_input_policy_to_the_engine(monkeypatch, say_endpoint):
    ar, calls = say_endpoint
    asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert calls["long_input"] == "speak"
    monkeypatch.setattr(ar, "_macos_say_settings", lambda: (True, {}, "reject"))
    asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert calls["long_input"] == "reject"


def test_the_engine_is_advertised_only_when_it_can_answer(monkeypatch):
    """`say` never occupies a pool slot, so the pool cannot name it. Strict
    clients validate the model id against GET /v1/models, which means the list
    has to carry it - and carry it only when a request would actually work."""
    from omlx.api import audio_routes as ar
    from omlx.utils import macos_say as engine

    monkeypatch.setattr(engine, "available", lambda: True)
    monkeypatch.setattr(ar, "_macos_say_settings", lambda: (True, {}, "speak"))
    assert ar.say_model_visible() is True
    monkeypatch.setattr(ar, "_macos_say_settings", lambda: (False, {}, "speak"))
    assert ar.say_model_visible() is False, "a switched-off engine is not offered"
    monkeypatch.setattr(engine, "available", lambda: False)
    monkeypatch.setattr(ar, "_macos_say_settings", lambda: (True, {}, "speak"))
    assert ar.say_model_visible() is False, "Linux has no say to offer"


def test_models_endpoint_lists_the_say_row(monkeypatch):
    import json as _json

    from omlx import server
    from omlx.api import audio_routes as ar

    async def ask():
        return await server.list_models(_=True)   # the auth dependency is moot here

    def listed():
        body = _json.loads(asyncio.run(ask()).body)
        return [m["id"] for m in body["data"]]

    monkeypatch.setattr(ar, "say_model_visible", lambda: True)
    ids = listed()
    assert "say" in ids

    monkeypatch.setattr(ar, "say_model_visible", lambda: False)
    ids = listed()
    assert "say" not in ids
    # the row is addressable as-is: the endpoint routes exactly this token
    assert ar._say_engine_request("say") == (True, "")


def test_speech_answers_400_for_a_language_the_mac_cannot_speak(say_endpoint):
    ar, calls = say_endpoint

    def raise_lookup(*args, **kwargs):
        raise LookupError("no installed macOS voice for language 'de-DE'")

    from omlx.utils import macos_say as engine

    engine.synth_bytes = raise_lookup
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ar._speech_via_macos_say(_speech_request(language="de-DE"), "", "wav"))
    assert exc.value.status_code == 400


def test_speech_answers_500_when_say_itself_fails(say_endpoint):
    ar, _ = say_endpoint
    from omlx.utils import macos_say as engine

    def explode(*args, **kwargs):
        raise RuntimeError("macOS say: no audio produced")

    engine.synth_bytes = explode
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert exc.value.status_code == 500


def test_speech_refuses_a_switched_off_engine(monkeypatch, say_endpoint):
    ar, calls = say_endpoint
    monkeypatch.setattr(ar, "_macos_say_settings", lambda: (False, {}, "speak"))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert exc.value.status_code == 400
    assert "switched off" in str(exc.value.detail)
    assert calls == {}


def test_speech_refuses_a_non_macos_server(monkeypatch, say_endpoint):
    ar, _ = say_endpoint
    from omlx.utils import macos_say as engine

    monkeypatch.setattr(engine, "available", lambda: False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ar._speech_via_macos_say(_speech_request(), "", "wav"))
    assert exc.value.status_code == 400
    assert "macOS" in str(exc.value.detail)


def test_speech_refuses_voice_cloning(monkeypatch, say_endpoint):
    ar, _ = say_endpoint
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            ar._speech_via_macos_say(_speech_request(ref_audio="AAAA"), "", "wav")
        )
    assert exc.value.status_code == 400
    assert "ref_audio" in str(exc.value.detail)


def test_openai_voice_field_is_ignored_when_it_is_not_a_macos_voice(say_endpoint):
    ar, calls = say_endpoint
    asyncio.run(ar._speech_via_macos_say(_speech_request(voice="alloy"), "", "wav"))
    assert calls["voice"] == ""


def test_macos_voice_from_the_voice_field_is_honoured(say_endpoint):
    ar, calls = say_endpoint
    from omlx.utils import macos_say as engine

    def fake_resolve(name):
        return {"name": name, "identifier": "id-" + name} if name == "Zuzana" else None

    engine.resolve = fake_resolve
    asyncio.run(ar._speech_via_macos_say(_speech_request(voice="Zuzana"), "", "wav"))
    assert calls["voice"] == "Zuzana"


def test_voice_named_in_the_model_token_is_held_to(say_endpoint):
    ar, _ = say_endpoint

    def explode(text, voice, language, voices, speed, long_input):
        raise LookupError("voice 'Ghost' is not installed on this Mac")

    from omlx.utils import macos_say as engine

    engine.synth_bytes = explode
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ar._speech_via_macos_say(_speech_request(), "Ghost", "wav"))
    assert exc.value.status_code == 400


def test_streaming_request_gets_the_finished_audio_in_chunks(say_endpoint):
    ar, _ = say_endpoint
    response = asyncio.run(
        ar._speech_via_macos_say(_speech_request(stream=True), "", "wav")
    )
    from fastapi.responses import StreamingResponse

    assert isinstance(response, StreamingResponse)

    async def collect():
        return [chunk async for chunk in response.body_iterator]

    pieces = asyncio.run(collect())
    assert b"".join(pieces).startswith(b"RIFF")


# --------------------------------------------------------- settings schema --


def test_admin_settings_expose_the_speech_fields():
    """The card reads them straight off /admin/api/global-settings."""
    from omlx.settings import IntegrationSettings

    payload = IntegrationSettings().to_dict()
    assert payload["say_enabled"] is True
    assert payload["say_voices"] == {}


def test_update_model_accepts_the_speech_fields():
    from omlx.admin.routes import GlobalSettingsRequest

    req = GlobalSettingsRequest(
        say_enabled=False, say_voices={"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"}
    )
    assert "say_enabled" in req.model_fields_set
    assert req.say_voices == {"cs-CZ": "com.apple.voice.premium.cs-CZ.Zuzana"}
