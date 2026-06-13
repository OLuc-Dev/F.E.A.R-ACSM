from __future__ import annotations

import uvicorn
from fastapi.middleware.cors import CORSMiddleware

from fear.config import Settings
from fear.web.unified_server import app

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def run() -> None:
    settings = Settings.from_env()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
