# SPDX-License-Identifier: Apache-2.0
"""Tests for /api/model-settings-index and /api/prune-model-settings (R11).

pytest asyncio_mode=auto collects these bare async tests.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

import omlx.server  # noqa: F401 - ensure server module is imported first
from omlx.admin import routes as admin_routes
from omlx.model_settings import ModelSettings


def _mgr(settings: dict):
    mgr = MagicMock()
    mgr.get_all_settings.return_value = settings
    mgr.delete_settings.side_effect = lambda mid: settings.pop(mid, None) is not None
    return mgr


def _pool(model_ids):
    pool = MagicMock()
    pool.get_model_ids.return_value = list(model_ids)
    return pool


def _ms(mid, alias=None):
    s = ModelSettings()
    s.model_alias = alias
    return s


async def test_index_reports_orphans_and_aliases():
    settings = {
        "live-model": _ms("live-model", alias="alias-target"),
        "gone-model": _ms("gone-model"),
        "alias-target": _ms("alias-target"),  # referenced by live-model's alias
    }
    with patch.object(admin_routes, "_get_settings_manager", return_value=_mgr(settings)), \
         patch.object(admin_routes, "_get_engine_pool", return_value=_pool(["live-model"])):
        out = await admin_routes.model_settings_index(is_admin=True)
    assert out["stored"] == 3
    assert out["known"] == 1
    # gone-model is an orphan; alias-target is kept by live-model's alias
    assert out["orphans"] == ["gone-model"]
    assert {"id": "live-model", "alias": "alias-target"} in out["entries"]


async def test_index_requires_pool():
    with patch.object(admin_routes, "_get_settings_manager", return_value=_mgr({})), \
         patch.object(admin_routes, "_get_engine_pool", return_value=None):
        with pytest.raises(HTTPException) as ei:
            await admin_routes.model_settings_index(is_admin=True)
    assert ei.value.status_code == 503


async def test_prune_deletes_only_listed_existing_ids():
    settings = {
        "a": _ms("a"),
        "b": _ms("b"),
    }
    mgr = _mgr(settings)
    with patch.object(admin_routes, "_get_settings_manager", return_value=mgr):
        out = await admin_routes.prune_model_settings(
            admin_routes.PruneModelSettingsRequest(ids=["a", "a", "ghost"]),
            is_admin=True,
        )
    assert out == {"removed": ["a"], "removed_templates": []}
    assert set(settings) == {"b"}


async def test_prune_rejects_empty_ids():
    with patch.object(admin_routes, "_get_settings_manager", return_value=_mgr({})):
        with pytest.raises(HTTPException) as ei:
            await admin_routes.prune_model_settings(
                admin_routes.PruneModelSettingsRequest(ids=[]), is_admin=True
            )
    assert ei.value.status_code == 400
