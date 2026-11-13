import logging

import synth
from fibo_alert.notifier import DiscordNotifier, webhook_from_env
from fibo_alert.store import Store

URL = "https://discord.com/api/webhooks/123456/SECRET-token_abc"


class Resp:
    def __init__(self, code, body=None, headers=None):
        self.status_code, self._b, self.headers = code, body or {}, headers or {}

    def json(self):
        return self._b


class Sess:
    def __init__(self, codes):
        self.codes, self.posts = list(codes), []

    def post(self, url, json=None, timeout=None):
        self.posts.append(json)
        c = self.codes.pop(0)
        if isinstance(c, Exception):
            raise c
        return c


def mk(codes):
    st = Store(":memory:", source="live")
    cfg = synth.cfg_for_tests()
    t = [0.0]
    sess = Sess(codes)
    n = DiscordNotifier(URL, st, cfg, sess, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0] + 1000)
    return st, n, sess, t


def add(st, key="k1"):
    st.add_alert(key, "OPS", None, 1_700_000_000_000, {"kind": "OPS", "title": "t", "detail": "d",
                                                         "bar_close": 1_700_000_000_000})


def test_sends_once_and_never_resends():
    st, n, sess, _ = mk([Resp(204)])
    add(st)
    add(st)  # 같은 dedupe 키는 한 번만
    assert n.flush() == 1 and n.flush() == 0 and len(sess.posts) == 1
    assert sess.posts[0]["allowed_mentions"] == {"parse": []}


def test_rate_limit_is_respected_and_not_counted_as_failure():
    st, n, sess, t = mk([Resp(429, {"retry_after": 3.0}), Resp(204)])
    add(st)
    assert n.flush() == 0
    assert n.flush() == 0  # 아직 대기 중
    t[0] += 4
    assert n.flush() == 1 and len(sess.posts) == 2


def test_limited_retries_then_failed_and_no_secret_in_logs(caplog):
    st, n, sess, t = mk([ConnectionError(URL)] * 5)
    add(st)
    with caplog.at_level(logging.DEBUG):
        for _ in range(8):
            n.flush()
            t[0] += 400
    row = st.conn.execute("SELECT status,attempts,last_error FROM alerts").fetchone()
    assert row[0] == "failed" and row[1] == 5 and len(sess.posts) == 5
    assert "SECRET" not in caplog.text and "SECRET" not in row[2]


def test_4xx_fails_without_retry():
    st, n, sess, _ = mk([Resp(404)])
    add(st)
    n.flush()
    n.flush()
    assert len(sess.posts) == 1
    assert st.conn.execute("SELECT status FROM alerts").fetchone()[0] == "failed"


def test_webhook_env_validation(monkeypatch):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    assert webhook_from_env() is None
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://evil.example/hook")
    try:
        webhook_from_env()
        assert False
    except ValueError as e:
        assert "evil" not in str(e)
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", URL)
    assert webhook_from_env() == URL
