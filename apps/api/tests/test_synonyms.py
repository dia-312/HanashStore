from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, SynonymGroup

V1 = "/api/v1"


def _put(api: TestClient, groups: list[dict[str, Any]]) -> Any:
    return api.put(V1 + "/synonyms", json={"groups": groups})


def _pull_groups(api: TestClient, cursor: int = 0) -> list[dict[str, Any]]:
    r = api.get(V1 + "/sync/pull", params={"cursor": cursor})
    assert r.status_code == 200, r.text
    groups: list[dict[str, Any]] = r.json()["changes"]["synonym_groups"]
    return groups


def test_requires_login(client: TestClient) -> None:
    assert client.get(V1 + "/synonyms").status_code == 401
    assert client.put(V1 + "/synonyms", json={"groups": []}).status_code == 401


def test_empty_at_first_because_tests_start_clean(api: TestClient) -> None:
    r = api.get(V1 + "/synonyms")
    assert r.status_code == 200
    assert r.json() == []


def test_terms_are_stored_normalized_and_deduplicated(api: TestClient) -> None:
    r = _put(api, [{"terms": ["أرجيلة", "اركيلة", "ارجيله", "شِيشة"]}])
    assert r.status_code == 200, r.text
    [group] = r.json()
    assert group["terms"] == ["ارجيله", "اركيله", "شيشه"]


def test_a_group_needs_two_different_words(api: TestClient) -> None:
    assert _put(api, [{"terms": ["فحم"]}]).status_code == 422
    r = _put(api, [{"terms": ["فحم", "فحم"]}])
    assert r.status_code == 422
    assert r.json()["code"] == "VALIDATION_ERROR"
    # Marks only: normalizes to nothing.
    assert _put(api, [{"terms": ["فحم", "!!!"]}]).status_code == 422
    assert api.get(V1 + "/synonyms").json() == []


def test_unknown_group_id_is_404_and_changes_nothing(api: TestClient) -> None:
    _put(api, [{"terms": ["فحم", "فحمات"]}])
    r = _put(
        api,
        [
            {"terms": ["راس", "حجر"]},
            {"id": "018f0000-0000-7000-8000-000000000000", "terms": ["ا", "ب"]},
        ],
    )
    assert r.status_code == 404
    assert [g["terms"] for g in api.get(V1 + "/synonyms").json()] == [["فحم", "فحمات"]]


def test_the_same_group_twice_is_refused(api: TestClient) -> None:
    [group] = _put(api, [{"terms": ["فحم", "فحمات"]}]).json()
    r = _put(
        api,
        [{"id": group["id"], "terms": ["فحم", "فحمات"]}, {"id": group["id"], "terms": ["ا", "ب"]}],
    )
    assert r.status_code == 422


def test_saving_the_same_list_changes_nothing_for_devices(api: TestClient) -> None:
    saved = _put(api, [{"terms": ["فحم", "فحمات"]}, {"terms": ["راس", "حجر"]}]).json()
    page = _pull_groups(api)
    cursor = max(g["change_seq"] for g in page)
    again = _put(api, [{"id": g["id"], "terms": g["terms"]} for g in saved])
    assert again.status_code == 200
    assert _pull_groups(api, cursor) == []


def test_an_edit_reaches_devices_and_a_removed_group_is_switched_off(api: TestClient) -> None:
    saved = _put(api, [{"terms": ["فحم", "فحمات"]}, {"terms": ["راس", "حجر"]}]).json()
    cursor = max(g["change_seq"] for g in _pull_groups(api))
    coal, head = saved
    # Edit the first, drop the second, add a third.
    r = _put(
        api, [{"id": coal["id"], "terms": ["فحم", "فحمات", "كربون"]}, {"terms": ["ماسك", "مبسم"]}]
    )
    assert r.status_code == 200
    changed = {g["id"]: g for g in _pull_groups(api, cursor)}
    assert changed[coal["id"]]["terms"] == ["فحم", "فحمات", "كربون"]
    assert changed[head["id"]]["is_active"] is False
    assert len(changed) == 3
    assert [g["terms"] for g in api.get(V1 + "/synonyms").json()] == [
        ["فحم", "فحمات", "كربون"],
        ["ماسك", "مبسم"],
    ]


def test_every_change_is_audited(api: TestClient, db: Session) -> None:
    [group] = _put(api, [{"terms": ["فحم", "فحمات"]}]).json()
    _put(api, [{"id": group["id"], "terms": ["فحم", "فحمات", "كربون"]}])
    _put(api, [])
    actions = [
        a.action for a in db.scalars(select(AuditLog).where(AuditLog.entity == "synonym_group"))
    ]
    assert sorted(actions) == ["create", "deactivate", "update"]
    row = db.get(SynonymGroup, group["id"])
    assert row is not None and row.is_active is False
