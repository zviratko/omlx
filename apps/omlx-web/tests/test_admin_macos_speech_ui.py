# SPDX-License-Identifier: Apache-2.0
"""The macOS Speech card in Settings > Integrations.

Pins the contract the card was built to: the engine switch defaults to on,
every language gets one dropdown whose first entry is what macOS itself
answers, and the choice that reaches the server is the voice identifier the
engine addresses `say -v` with. Also guards the defects found while wiring it
up: an uncompiled Tailwind width, and a `:value` binding that lost the race
with the option list and silently showed 'macOS default' over a saved voice.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "omlx_web/templates/dashboard/_settings.html").read_text()
DASHBOARD_JS = (ROOT / "omlx_web/static/js/dashboard.js").read_text()
EN = json.loads((ROOT / "omlx_web/i18n/en.json").read_text())

CARD_START = TEMPLATE.index("settings.integrations.speech.section_label")
CARD = TEMPLATE[CARD_START: TEMPLATE.index("settings.integrations.markitdown.section_label")]


def test_speech_card_sits_inside_the_integrations_tab():
    tab_start = TEMPLATE.index("activeTab === 'integrations'")
    tab_end = TEMPLATE.index("activeTab === 'models'")
    assert tab_start < CARD_START < tab_end


def test_every_key_the_card_uses_exists_in_the_catalog():
    used = set(re.findall(r"settings\.integrations\.speech\.[a-z_]+", TEMPLATE))
    used |= set(re.findall(r"settings\.integrations\.speech\.[a-z_]+", DASHBOARD_JS))
    missing = sorted(k for k in used if k not in EN)
    assert not missing, f"keys used but never defined: {missing}"
    # The two plural forms the helpers look up by suffix.
    for base in ("voice_count", "languages_badge"):
        assert f"settings.integrations.speech.{base}" in EN
        assert f"settings.integrations.speech.{base}_one" in EN


def test_placeholders_match_between_catalog_and_card():
    assert "{count}" in EN["settings.integrations.speech.languages_badge"]
    assert "{count}" in EN["settings.integrations.speech.voice_count"]
    assert "{voice}" in EN["settings.integrations.speech.default_preference"]
    # The unnamed default must never claim a voice: it carries no placeholder.
    assert "{" not in EN["settings.integrations.speech.default_system"]


def test_engine_switch_is_bound_to_the_settings_field():
    assert "toggleSayEnabled()" in CARD
    assert "globalSettings.integrations.say_enabled" in CARD
    # A server without the synthesizer cannot be talked into offering it.
    assert ':disabled="!globalSettings.integrations.say_supported"' in CARD
    assert 'role="switch"' in CARD


def test_each_language_row_offers_the_macos_default_first():
    rows = re.findall(r'x-for="lang in[^"]*"[^>]*:key="lang\.locale"', CARD, re.DOTALL)
    assert len(rows) == 1, "the card must render one dropdown per language"
    default_option = CARD.index('x-text="sayDefaultLabel(lang)"')
    voice_option = CARD.index('<template x-for="v in lang.voices"')
    assert default_option < voice_option, "the empty (macOS default) entry comes first"
    assert '<option value="" :selected="!lang.configured"' in CARD[:voice_option]


def test_saved_choice_is_marked_selected_on_the_option_itself():
    """A select whose options come from x-for cannot be primed by `:value` or
    `x-effect`: Alpine initialises the select before its children exist, so
    the assignment lands on an empty list and a saved voice renders as
    'macOS default'. `:selected` on the option has no such ordering trap."""
    # The language dropdown, not the card's other selects.
    at = CARD.index("setSayVoice(lang,")
    start = CARD.rindex("<select", 0, at)
    select_tag = CARD[start : CARD.index(">", start)]
    assert ":value=" not in select_tag and "x-effect=" not in select_tag
    assert '@change="setSayVoice(lang, $event.target.value)"' in select_tag
    options = CARD[start : CARD.index("</select>", start)]
    assert ':selected="!lang.configured"' in options
    assert ':selected="v.value === lang.configured"' in options


def test_card_uses_only_compiled_tailwind_widths():
    """Tailwind here is a prebuilt catalog: a width class it never compiled
    (w-72) silently leaves the control full width."""
    compiled = (ROOT / "omlx_web/static/css/tailwind.css").read_text()
    for cls in set(re.findall(r"\bsm:(w-\w+)\b", CARD)):
        assert f".sm\\:{cls}" in compiled, f"sm:{cls} is not in tailwind.css"


def test_dashboard_state_defaults_to_the_engine_being_on():
    start = DASHBOARD_JS.index("integrations: {")
    block = DASHBOARD_JS[start: DASHBOARD_JS.index("external_engines: {", start)]
    assert "say_enabled: true" in block
    assert "say_voices: {}" in block
    assert "say_supported: false" in block


def test_voices_are_loaded_when_the_tab_opens():
    assert "async loadMacosSayVoices(force)" in DASHBOARD_JS
    assert "fetch('/admin/api/macos-say/voices')" in DASHBOARD_JS
    # Both doors into the tab: the click and a deep link that skips it.
    tab_handler = DASHBOARD_JS[DASHBOARD_JS.index("setSettingsTab(tab) {"):]
    tab_handler = tab_handler[: tab_handler.index("\n            },")]
    assert "this.loadMacosSayVoices()" in tab_handler
    assert "if (this.activeTab === 'integrations')" in DASHBOARD_JS


def test_saves_send_the_whole_voice_map():
    save = DASHBOARD_JS[DASHBOARD_JS.index("async saveIntegrationSettings()"):]
    save = save[: save.index("\n            },")]
    assert "say_enabled: this.globalSettings.integrations.say_enabled" in save
    assert "say_voices: this.sayVoicesMap()" in save
    # A language back on its default leaves the map instead of pinning ''.
    assert "if (lang.configured) out[lang.locale] = lang.configured;" in DASHBOARD_JS


def test_long_input_policy_is_an_operator_choice_on_the_card():
    """Past OpenAI's input limit the engine either speaks everything or
    refuses. The caller does not pick: it asked for audio."""
    at = CARD.index("globalSettings.integrations.say_long_input")
    start = CARD.rindex("<select", 0, at)
    tag = CARD[start : CARD.index(">", start)]
    assert 'x-model="globalSettings.integrations.say_long_input"' in tag
    assert '@change="saveSayLongInput()"' in tag
    options = CARD[start : CARD.index("</select>", start)]
    assert '<option value="speak">' in options
    assert '<option value="reject">' in options
    # Both labels come from the catalog, never hardcoded in the template.
    for key in ("long_label", "long_hint", "long_speak", "long_reject"):
        assert f"settings.integrations.speech.{key}" in CARD
        assert EN[f"settings.integrations.speech.{key}"]


def test_dashboard_defaults_to_speaking_long_text():
    start = DASHBOARD_JS.index("integrations: {")
    block = DASHBOARD_JS[start : DASHBOARD_JS.index("external_engines: {", start)]
    assert "say_long_input: 'speak'" in block
    save = DASHBOARD_JS[DASHBOARD_JS.index("async saveIntegrationSettings()") :]
    save = save[: save.index("\n            },")]
    assert (
        "say_long_input: this.globalSettings.integrations.say_long_input" in save
    )


def test_a_failed_save_puts_the_dropdown_back():
    handler = DASHBOARD_JS[DASHBOARD_JS.index("setSayVoice(lang, value) {"):]
    handler = handler[: handler.index("\n            },")]
    assert "const previous = lang.configured" in handler
    assert "lang.configured = previous;" in handler
