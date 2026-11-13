"""Discord Webhook 전송(outbox 방식). 웹훅 URL 은 환경변수에서만 읽고 로그에 남기지 않는다.

at-least-once: 전송 성공 후 DB 기록 직전에 프로세스가 죽으면 같은 알림이 한 번 더 갈 수 있다.
"""
from __future__ import annotations

import logging
import os
import re
import time

import requests

from .messages import build

log = logging.getLogger("fibo.notifier")
_URL_RE = re.compile(r"^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$")


def webhook_from_env(var="DISCORD_WEBHOOK_URL") -> str | None:
    url = os.environ.get(var, "").strip()
    if not url:
        return None
    if not _URL_RE.match(url):
        raise ValueError(f"{var} 형식이 올바른 Discord 웹훅 URL 이 아닙니다(값은 출력하지 않음)")
    return url


class DiscordNotifier:
    def __init__(self, url, store, cfg, session=None, sleep=time.sleep, clock=time.time):
        self._url, self.st, self.cfg = url, store, cfg
        self.sess = session or requests.Session()
        self.sleep, self.clock = sleep, clock
        self._last_send = 0.0
        self._blocked_until = 0.0

    def _post(self, embed):
        body = {"username": "Fibo Alert", "embeds": [embed], "allowed_mentions": {"parse": []}}
        return self.sess.post(self._url, json=body, timeout=10)

    def flush(self, limit=20) -> int:
        sent = 0
        now = self.clock()
        if now < self._blocked_until:
            return 0
        for aid, key, kind, payload, attempts in self.st.pending_alerts(now, limit):
            wait = self.cfg.alerts.min_interval_s - (self.clock() - self._last_send)
            if wait > 0:
                self.sleep(wait)
            try:
                r = self._post(build(kind, payload, self.cfg.display_tz))
                self._last_send = self.clock()
            except Exception as e:  # URL 이 예외 메시지에 섞이지 않도록 클래스명만 기록
                attempts += 1
                self._fail(aid, attempts, f"network:{type(e).__name__}")
                continue
            if r.status_code in (200, 204):
                self.st.mark_alert(aid, "sent", attempts + 1)
                sent += 1
            elif r.status_code == 429:  # Discord rate limit: retry_after 만큼 전체 대기
                try:
                    ra = float(r.json().get("retry_after", r.headers.get("Retry-After", 1)))
                except Exception:
                    ra = 2.0
                self._blocked_until = self.clock() + ra
                self.st.mark_alert(aid, "pending", attempts, self.clock() + ra, "429")
                log.warning("discord rate limited, retry in %.1fs", ra)
                break
            elif 500 <= r.status_code < 600:
                self._fail(aid, attempts + 1, f"http:{r.status_code}")
            else:  # 4xx: 재시도해도 소용없음(잘못된 웹훅 등)
                self.st.mark_alert(aid, "failed", attempts + 1, None, f"http:{r.status_code}")
                log.error("discord rejected alert %s: http %s", key, r.status_code)
        return sent

    def _fail(self, aid, attempts, err):
        if attempts >= self.cfg.alerts.max_attempts:
            self.st.mark_alert(aid, "failed", attempts, None, err)
            log.error("alert %s failed permanently (%s)", aid, err)
        else:
            self.st.mark_alert(aid, "pending", attempts, self.clock() + min(300, 2 ** attempts * 2), err)
