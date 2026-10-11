import pandas as pd

from promoter_tracker import pledges


def test_classify_uses_type_then_mode():
    assert pledges.classify("Pledge", "Pledge Creation") == "created"
    assert pledges.classify("Pledge Revoke", "-") == "released"
    assert pledges.classify("Pledge Invoke", "Invocation of pledge") == "invoked"
    assert pledges.classify("-", "Revokation of Pledge") == "released"
    assert pledges.classify("Buy", "Market Purchase") is None


def row(kind_type, mode, qty, day, symbol="ABC", person="Founder", category="Promoter"):
    return {"symbol": symbol, "company": f"{symbol} Ltd", "person": person, "category": category,
            "txn_type": kind_type, "mode": mode, "quantity": qty, "value": 47.0,
            "holding_before_pct": 10.0, "holding_after_pct": 10.0, "trade_key": f"{person}{day}{qty}",
            "disclosure_date": pd.Timestamp(day), "trade_to": pd.Timestamp(day)}


def test_events_are_valued_at_the_close_and_summarised():
    closes = pd.Series([100.0, 200.0], index=pd.to_datetime(["2024-01-01", "2024-06-01"]))
    trades = pd.DataFrame([
        row("Pledge", "Pledge Creation", 1000, "2024-01-05"),
        row("Pledge Revoke", "Pledge Release", 400, "2024-02-01"),
        row("Pledge Invoke", "Invocation of pledge", 100, "2024-06-03"),
        row("Pledge", "Pledge Creation", 999, "2024-01-05", category="Director"),  # not a promoter
        row("Buy", "Market Purchase", 50, "2024-01-05"),
    ])
    ev = pledges.pledge_events(trades, lambda s: closes)
    assert list(ev["kind"]) == ["invoked", "released", "created"]
    assert ev.iloc[0]["value"] == 100 * 200.0 and ev.iloc[2]["value"] == 1000 * 100.0
    [c] = pledges.summarize(ev, shares=pd.Series({"ABC": 10_000}))
    assert c["net_shares"] == 500 and c["net_pct"] == 5.0
    assert c["risk"] == "high" and c["invocations"] == 1  # invoked within 90 days


def test_risk_labels():
    closes = pd.Series([10.0], index=pd.to_datetime(["2023-01-01"]))
    rising = pledges.pledge_events(pd.DataFrame([row("Pledge", "Pledge Creation", 10, "2024-01-01")]),
                                   lambda s: closes)
    assert pledges.summarize(rising)[0]["risk"] == "rising"
    easing = pledges.pledge_events(pd.DataFrame([row("Pledge Revoke", "-", 10, "2024-01-01")]),
                                   lambda s: closes)
    assert pledges.summarize(easing)[0]["risk"] == "easing"
