import json
from datetime import date
from pathlib import Path

from promoter_tracker import nse_client
from promoter_tracker.nse_client import date_chunks, parse_date, parse_number, parse_response

FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"


def load():
    return parse_response(json.loads(FIXTURE.read_text()))


def test_parses_all_usable_records():
    trades = load()
    assert len(trades) == 7  # the record without a symbol is dropped
    first = trades[0]
    assert first["symbol"] == "ABCLTD"
    assert first["person"] == "Ravi Kumar"
    assert first["quantity"] == 10000
    assert first["value"] == 2_500_000
    assert first["trade_to"] == "2024-01-03"
    assert first["disclosure_date"] == "2024-01-05"


def test_handles_commas_dashes_and_alternate_field_names():
    trades = {(t["symbol"], t["txn_type"]): t for t in load()}
    assert trades[("ABCLTD", "Buy")]["quantity"] in (10000, 5000)
    assert trades[("XYZIND", "Pledge")]["value"] is None
    alt = trades[("NEWFMT", "Buy")]
    assert alt["company"] == "New Format Ltd"
    assert alt["person"] == "Asha Rao"
    assert alt["disclosure_date"] == "2024-01-03"
    assert alt["value"] == 25000.5


def test_parse_helpers():
    assert parse_date("05-Jan-2024 18:30") == "2024-01-05"
    assert parse_date("-") is None
    assert parse_date("garbage") is None
    assert parse_number("1,23,456.5") == 123456.5
    assert parse_number("Nil") is None


def test_parse_response_accepts_bare_list_and_empty():
    assert parse_response([]) == []
    assert parse_response({"data": None}) == []
    assert len(parse_response([{"symbol": "A", "date": "01-Jan-2024"}])) == 1


def test_date_chunks_cover_range_without_gaps():
    chunks = list(date_chunks(date(2024, 1, 1), date(2024, 3, 15), days=30))
    assert chunks[0] == (date(2024, 1, 1), date(2024, 1, 30))
    assert chunks[-1][1] == date(2024, 3, 15)
    for (_, a_end), (b_start, _) in zip(chunks, chunks[1:]):
        assert (b_start - a_end).days == 1


def test_fetch_pit_chunks_and_parses(monkeypatch):
    calls = []
    payload = json.loads(FIXTURE.read_text())

    def fake_get_json(self, url, params):
        calls.append(params)
        return payload

    monkeypatch.setattr(nse_client.NSEClient, "_get_json", fake_get_json)
    monkeypatch.setattr(nse_client.time, "sleep", lambda s: None)
    trades = nse_client.NSEClient().fetch_pit(date(2024, 1, 1), date(2024, 2, 15), symbol="abcltd")
    assert len(calls) == 2
    assert calls[0]["from_date"] == "01-01-2024" and calls[0]["symbol"] == "ABCLTD"
    assert len(trades) == 14


XBRL_FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_xbrl_sample.xml"


def test_parse_xbrl_extracts_each_disclosure():
    trades = nse_client.parse_xbrl(XBRL_FIXTURE.read_text(encoding="utf-8"), "2026-09-26")
    assert len(trades) == 3
    first = trades[0]
    assert first["symbol"] == "DAMODARIND"
    assert first["company"] == "DAMODAR INDUSTRIES LIMITED"
    assert first["person"] == "Calves N Leaves Initiatives Private Limited"
    assert first["category"] == "Promoter Group"
    assert first["security_type"] == "Equity Shares"
    assert first["quantity"] == 4200 and first["value"] == 124110
    assert first["txn_type"] == "Sell" and first["mode"] == "Market Sale"
    # Fractions in the XBRL become percentages like the legacy data.
    assert first["holding_before_pct"] == 1.02 and first["holding_after_pct"] == 1.0
    assert first["trade_from"] == first["trade_to"] == "2026-09-23"
    assert first["intimation_date"] == "2026-09-25"
    assert first["disclosure_date"] == "2026-09-26"
    assert trades[1]["txn_type"] == "Buy" and trades[1]["person"] == "Manju Biyani"


def test_parse_xbrl_falls_back_to_filing_date():
    trades = nse_client.parse_xbrl(XBRL_FIXTURE.read_text(encoding="utf-8"))
    assert trades[0]["disclosure_date"] == "2026-09-26"


def test_fetch_pit_uses_legacy_then_xbrl_endpoint(monkeypatch):
    legacy = json.loads(FIXTURE.read_text())
    xml = XBRL_FIXTURE.read_text(encoding="utf-8")
    listing = {"data": [
        {"symbol": "DAMODARIND", "appId": "1", "xmlFileName": "orig.xml",
         "broadcastDateTime": "26-Sep-2026 20:02:21"},
        {"symbol": "DAMODARIND", "appId": "2", "prevAppId": "1", "xmlFileName": "rev.xml",
         "broadcastDateTime": "27-Sep-2026 10:00:00"},
        {"symbol": "BROKEN", "appId": "3", "xmlFileName": "bad.xml",
         "broadcastDateTime": "27-Sep-2026 11:00:00"},
    ]}
    urls, fetched = [], []

    def fake_get_json(self, url, params):
        urls.append((url, params["from_date"], params["to_date"]))
        return legacy if url == nse_client.PIT_URL else listing

    def fake_get_text(self, url):
        fetched.append(url)
        if url == "bad.xml":
            raise RuntimeError("404")
        return xml

    monkeypatch.setattr(nse_client.NSEClient, "_get_json", fake_get_json)
    monkeypatch.setattr(nse_client.NSEClient, "_get_text", fake_get_text)
    monkeypatch.setattr(nse_client.time, "sleep", lambda s: None)
    client = nse_client.NSEClient()
    trades = client.fetch_pit(date(2026, 4, 20), date(2026, 5, 10))

    assert urls == [(nse_client.PIT_URL, "20-04-2026", "02-05-2026"),
                    (nse_client.PIT_XBRL_URL, "03-05-2026", "10-05-2026")]
    assert sorted(fetched) == ["bad.xml", "rev.xml"]  # the revised original is skipped
    assert client.failed_filings == ["bad.xml"]
    assert len(trades) == 7 + 3
    assert trades[-1]["disclosure_date"] == "2026-09-27"


def test_archive_403_pauses_all_workers_then_retries(monkeypatch):
    class Resp:
        def __init__(self, code):
            self.status_code, self.text = code, "<xml/>"

        def raise_for_status(self):
            if self.status_code >= 400:
                raise nse_client.requests.HTTPError(str(self.status_code))

    codes = iter([403, 200])
    sleeps = []
    client = nse_client.NSEClient()
    monkeypatch.setattr(client.session, "get", lambda url, timeout: Resp(next(codes)))
    monkeypatch.setattr(nse_client.time, "sleep", sleeps.append)
    assert client._get_text("f.xml") == "<xml/>"
    assert max(sleeps) > nse_client.ARCHIVE_COOLDOWN - 5  # waited out the cooldown
    assert client._blocked_until > 0
