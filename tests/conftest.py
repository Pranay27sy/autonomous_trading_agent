import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def no_company_lookups(monkeypatch):
    """Refreshes in tests must not call Yahoo for company info."""
    from promoter_tracker import companies

    monkeypatch.setattr(companies, "fetch_info", lambda symbol: {})
