"""Uplift dashboard — opt-in companion UI for oMLX.

Installable add-on: vanilla oMLX stays byte-identical, the wrapper CLI
(`omlx-uplift serve`) mounts this package's router into `omlx.server.app`
and starts the metrics collector in the same asyncio loop.

Mount points (registered by `register(app)`):
  /uplift/...            static UI + login gate (canonical)
  /admin/uplift/...      legacy alias so bookmarks keep working
  /uplift/api/...        uplift-only JSON API (requests feed, settings
                         index, prune, GET/DELETE model settings,
                         /models overlay with used_by)
  /admin/api/...         alias mount of the same API for the standalone
                         dev gateway (?api=) compatibility
"""

__version__ = "0.1.0"


def register(app) -> None:
    """Mount all Uplift routes onto a FastAPI app (idempotent per app)."""
    from .router import api_router, page_router

    if getattr(app, "_omlx_uplift_mounted", False):
        return
    app.include_router(page_router)
    app.include_router(api_router, prefix="/uplift/api", include_in_schema=True)
    # Legacy/dev-gateway alias: identical handlers under /admin/api.
    app.include_router(api_router, prefix="/admin/api", include_in_schema=False)
    # Collector lives in omlx's own loop — no separate daemon. Vanilla
    # servers without this package simply never reach this code.
    from .collector import get_collector

    collector = get_collector()
    app.add_event_handler("startup", collector.start)
    app.add_event_handler("shutdown", collector.stop)
    app._omlx_uplift_mounted = True
