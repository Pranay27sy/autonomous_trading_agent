import json
from pathlib import Path

import pytest
import streamlit as st
from streamlit.testing.v1 import AppTest

from promoter_tracker.nse_client import parse_response
from promoter_tracker.store import Store

APP = Path(__file__).resolve().parent.parent / "promoter_tracker" / "app.py"
FIXTURE = Path(__file__).parent / "fixtures" / "nse_pit_sample.json"


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "app.db"
    monkeypatch.setenv("PROMOTER_DB", str(path))
    monkeypatch.setenv("PROMOTER_AUTO_REFRESH", "0")
    st.cache_data.clear()
    st.cache_resource.clear()
    yield path
    st.cache_data.clear()
    st.cache_resource.clear()


def test_app_picks_up_a_refresh_made_outside_it(db):
    at = AppTest.from_file(str(APP), default_timeout=60).run()
    assert any("No promoter trades" in i.value for i in at.info)

    # A scheduled `python -m promoter_tracker.refresh` writes to the same database.
    store = Store(db)
    store.upsert_trades(parse_response(json.loads(FIXTURE.read_text())))
    store.mark_refreshed()
    store.close()

    at.run()
    assert not at.exception
    assert not any("No promoter trades" in i.value for i in at.info)
    assert int(at.metric[0].value) > 0
