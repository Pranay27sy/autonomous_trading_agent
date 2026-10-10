"""Send new alerts as one digest per refresh to Telegram and/or email.

Channels are configured only through environment variables (see config.py),
so tokens and passwords never live in the database or reach the browser.
"""
from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

import requests

from .config import Settings

log = logging.getLogger(__name__)

TELEGRAM_LIMIT = 4096  # characters per message
MAX_LINES = 25


class Channel(Protocol):
    name: str

    def send(self, subject: str, text: str) -> None: ...


@dataclass
class TelegramChannel:
    token: str
    chat_id: str
    name: str = "telegram"

    def send(self, subject: str, text: str) -> None:
        body = f"{subject}\n\n{text}"
        if len(body) > TELEGRAM_LIMIT:
            body = body[: TELEGRAM_LIMIT - 2] + " …"
        resp = requests.post(f"https://api.telegram.org/bot{self.token}/sendMessage",
                             json={"chat_id": self.chat_id, "text": body,
                                   "disable_web_page_preview": True},
                             timeout=15)
        if resp.status_code != 200:
            # Telegram's description says what's wrong (bad chat id, blocked bot)
            # without echoing the token, unlike the request URL.
            try:
                reason = resp.json().get("description", "")
            except ValueError:
                reason = ""
            raise RuntimeError(f"Telegram answered {resp.status_code} {reason}".strip())


@dataclass
class EmailChannel:
    host: str
    port: int
    sender: str
    to: list[str]
    user: str | None = None
    password: str | None = None
    name: str = "email"

    def send(self, subject: str, text: str) -> None:
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = subject, self.sender, ", ".join(self.to)
        msg.set_content(text)
        if self.port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(self.host, self.port, timeout=20)
        else:
            server = smtplib.SMTP(self.host, self.port, timeout=20)
            server.starttls()
        with server:
            if self.user:
                server.login(self.user, self.password or "")
            server.send_message(msg)


def channels_from(settings: Settings) -> list[Channel]:
    out: list[Channel] = []
    if settings.telegram_bot_token and settings.telegram_chat_id:
        out.append(TelegramChannel(settings.telegram_bot_token, settings.telegram_chat_id))
    if settings.smtp_host and settings.alert_email_to:
        out.append(EmailChannel(settings.smtp_host, settings.smtp_port,
                                settings.smtp_from or settings.smtp_user or "promoter-tracker",
                                settings.alert_email_to, settings.smtp_user,
                                settings.smtp_password))
    return out


def digest(alerts: list[dict], public_url: str | None = None) -> tuple[str, str]:
    """(subject, plain-text body) summarising alerts, newest first."""
    n = len(alerts)
    subject = f"Promoter tracker: {n} new alert{'s' if n != 1 else ''}"
    lines = []
    for a in alerts[:MAX_LINES]:
        lines.append(f"• {a['title']}")
        if a.get("detail"):
            lines.append(f"  {a['detail']}")
        if public_url:
            lines.append(f"  {public_url.rstrip('/')}/stock/{a['symbol']}")
    if n > MAX_LINES:
        lines.append(f"…and {n - MAX_LINES} more in the app.")
    return subject, "\n".join(lines)


def send(alerts: list[dict], channels: list[Channel], public_url: str | None = None) -> list[str]:
    """Deliver a digest on every channel. Returns one error message per failed channel."""
    if not alerts or not channels:
        return []
    subject, text = digest(alerts, public_url)
    errors = []
    for ch in channels:
        try:
            ch.send(subject, text)
        except Exception as err:  # one broken channel must not stop the others
            log.warning("Sending alerts by %s failed: %s", ch.name, err)
            errors.append(f"Alerts by {ch.name}: {err}")
    return errors
