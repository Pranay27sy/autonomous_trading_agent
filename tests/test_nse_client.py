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
