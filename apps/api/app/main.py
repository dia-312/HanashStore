import mimetypes
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import clock, storage
from app.db import get_engine
from app.errors import error_response, install_error_handlers
from app.ratelimit import LoginLimiter
from app.routers import (
    auth,
    categories,
    devices,
    documents,
    images,
    imports,
    products,
    settings,
    sync,
    variants,
)
from app.services import pdf

# The Windows registry has no entry for WebP, which would make dev serve images as octet-stream.
mimetypes.add_type("image/webp", ".webp")

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # In the background, so the API answers at once while WeasyPrint loads.
    threading.Thread(target=pdf.warm_up, name="pdf-warm-up", daemon=True).start()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Sales Rep API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )
    app.state.login_limiter = LoginLimiter()
    install_error_handlers(app)

    @app.middleware("http")
    async def csrf_and_server_time(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Cookie auth needs a custom header on every state-changing request: a cross-site form or
        # image can't set it, and a cross-origin fetch that tries must pass a CORS preflight.
        if request.method in _UNSAFE_METHODS and request.headers.get("x-requested-with") != "app":
            response: Response = error_response(
                403, "CSRF_REJECTED", "Missing X-Requested-With header"
            )
        else:
            response = await call_next(request)
        # Lets the device notice a badly wrong clock (SPEC section 12).
        response.headers["X-Server-Time"] = clock.utcnow().isoformat()
        return response

    @app.get("/api/health", include_in_schema=False)
    def health() -> Response:
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
        except SQLAlchemyError:
            return error_response(503, "DB_DOWN", "Database unreachable")
        return Response('{"status":"ok"}', media_type="application/json")

    app.include_router(auth.router, prefix="/api/v1")
    app.include_router(devices.router, prefix="/api/v1")
    for module in (categories, products, variants, images, sync, imports, settings, documents):
        app.include_router(module.router, prefix="/api/v1")
    # Caddy serves /media straight from the volume in production; this keeps dev and tests simple.
    app.mount("/media", StaticFiles(directory=storage.media_root(), check_dir=False), name="media")
    return app


app = create_app()
