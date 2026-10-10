"""Settings read from environment variables, and logging setup.

| Variable                 | Default             | Meaning                                    |
|--------------------------|---------------------|--------------------------------------------|
| PROMOTER_DB              | data/promoter.db    | SQLite path                                |
| PROMOTER_AUTO_REFRESH    | 1                   | 0 stops the app refreshing stale data      |
| PROMOTER_STALE_HOURS     | 6                   | Age after which the app auto-refreshes     |
| PROMOTER_LOG_LEVEL       | INFO                | Python logging level                       |
| PROMOTER_LOG_FILE        | (none)              | Also log to this file, rotated at 5 MB     |
| PROMOTER_FRONTEND_DIST   | frontend/dist       | Built web frontend served at /             |
| PROMOTER_PUBLIC_URL      | (none)              | App URL, for links in alert messages       |

Alert delivery (optional; alerts always show in the app):
| PROMOTER_TELEGRAM_BOT_TOKEN, PROMOTER_TELEGRAM_CHAT_ID | Telegram bot and chat     |
| PROMOTER_SMTP_HOST, PROMOTER_SMTP_PORT (587)           | SMTP server (465 = SSL)   |
| PROMOTER_SMTP_USER, PROMOTER_SMTP_PASSWORD             | SMTP login, if needed     |
| PROMOTER_SMTP_FROM, PROMOTER_ALERT_EMAIL_TO            | sender; comma-separated recipients |
"""
from __future__ import annotations

import logging
import logging.handlers
import os
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Mapping

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "promoter.db"
DEFAULT_FRONTEND = Path(__file__).resolve().parent.parent / "frontend" / "dist"
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


@dataclass(frozen=True)
class Settings:
    db_path: Path = DEFAULT_DB
    auto_refresh: bool = True
    stale_after: timedelta = timedelta(hours=6)
    log_level: str = "INFO"
    log_file: Path | None = None
    frontend_dist: Path = DEFAULT_FRONTEND
    public_url: str | None = None
    # Secrets are kept out of repr so a logged Settings never leaks them.
    telegram_bot_token: str | None = field(default=None, repr=False)
    telegram_chat_id: str | None = None
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = field(default=None, repr=False)
    smtp_from: str | None = None
    alert_email_to: list[str] = field(default_factory=list)


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    try:
        stale_hours = float(env.get("PROMOTER_STALE_HOURS", "6"))
    except ValueError:
        raise ValueError("PROMOTER_STALE_HOURS must be a number of hours") from None
    log_file = env.get("PROMOTER_LOG_FILE")
    return Settings(
        db_path=Path(env.get("PROMOTER_DB") or DEFAULT_DB),
        auto_refresh=env.get("PROMOTER_AUTO_REFRESH", "1") != "0",
        stale_after=timedelta(hours=stale_hours),
        log_level=env.get("PROMOTER_LOG_LEVEL", "INFO").upper(),
        log_file=Path(log_file) if log_file else None,
        frontend_dist=Path(env.get("PROMOTER_FRONTEND_DIST") or DEFAULT_FRONTEND),
        public_url=env.get("PROMOTER_PUBLIC_URL") or None,
        telegram_bot_token=env.get("PROMOTER_TELEGRAM_BOT_TOKEN") or None,
        telegram_chat_id=env.get("PROMOTER_TELEGRAM_CHAT_ID") or None,
        smtp_host=env.get("PROMOTER_SMTP_HOST") or None,
        smtp_port=int(env.get("PROMOTER_SMTP_PORT") or 587),
        smtp_user=env.get("PROMOTER_SMTP_USER") or None,
        smtp_password=env.get("PROMOTER_SMTP_PASSWORD") or None,
        smtp_from=env.get("PROMOTER_SMTP_FROM") or None,
        alert_email_to=[a.strip() for a in (env.get("PROMOTER_ALERT_EMAIL_TO") or "").split(",")
                        if a.strip()],
    )


def configure_logging(settings: Settings) -> None:
    """Log to stderr (and the log file, if set). Safe to call more than once."""
    root = logging.getLogger()
    if getattr(root, "_promoter_configured", False):
        return
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if settings.log_file:
        settings.log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.handlers.RotatingFileHandler(
            settings.log_file, maxBytes=5_000_000, backupCount=3, encoding="utf-8"))
    for h in handlers:
        h.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(h)
    root.setLevel(settings.log_level)
    root._promoter_configured = True  # type: ignore[attr-defined]
