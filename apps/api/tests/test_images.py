import io
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from tests import helpers

V1 = "/api/v1"


def make_image(
    fmt: str = "JPEG", size: tuple[int, int] = (800, 600), exif: Image.Exif | None = None
) -> bytes:
    out = io.BytesIO()
    kwargs = {"exif": exif} if exif is not None and fmt == "JPEG" else {}
    Image.new("RGB", size, (200, 30, 30)).save(out, fmt, **kwargs)
    return out.getvalue()


def upload(
    api: TestClient, product_id: str, data: bytes, name: str = "photo.jpg", **form: str
) -> httpx.Response:
    response: httpx.Response = api.post(
        f"{V1}/products/{product_id}/images",
        files={"file": (name, data, "image/jpeg")},
        data=form,
    )
    return response


def stored(url: str) -> Path:
    return Path(get_settings().media_dir) / url.removeprefix("/media/")


def test_upload_stores_a_thumb_and_a_full_size_webp(api: TestClient) -> None:
    p = helpers.product(api)
    r = upload(api, p["id"], make_image(size=(3000, 2000)))
    assert r.status_code == 201, r.text
    body = r.json()
    thumb, full = Image.open(stored(body["thumb_url"])), Image.open(stored(body["full_url"]))
    assert thumb.format == full.format == "WEBP"
    assert max(thumb.size) == 400 and max(full.size) == 1200
    assert thumb.size == (400, 267)  # aspect ratio kept
    assert body["sort_order"] == 0 and body["variant_id"] is None


def test_small_images_are_not_enlarged(api: TestClient) -> None:
    p = helpers.product(api)
    body = upload(api, p["id"], make_image(size=(120, 80))).json()
    assert Image.open(stored(body["full_url"])).size == (120, 80)


def test_exif_is_stripped_and_rotation_is_applied(api: TestClient) -> None:
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    exif[0x0112] = 6  # "rotate 90 degrees": the photo was taken in portrait
    p = helpers.product(api)
    body = upload(api, p["id"], make_image(size=(200, 100), exif=exif)).json()
    for key in ("thumb_url", "full_url"):
        raw = stored(body[key]).read_bytes()
        assert b"SecretCameraMaker" not in raw
        assert not Image.open(io.BytesIO(raw)).getexif()
    assert Image.open(stored(body["full_url"])).size == (100, 200)


def test_png_with_transparency_is_flattened_on_white(api: TestClient) -> None:
    out = io.BytesIO()
    Image.new("RGBA", (50, 50), (0, 0, 0, 0)).save(out, "PNG")
    p = helpers.product(api)
    body = upload(api, p["id"], out.getvalue(), "logo.png").json()
    pixel = Image.open(stored(body["full_url"])).convert("RGB").getpixel((10, 10))
    assert isinstance(pixel, tuple) and min(pixel) > 240


def test_the_uploaded_file_name_is_never_used(api: TestClient) -> None:
    p = helpers.product(api)
    r = upload(api, p["id"], make_image(), "../../../etc/evil.jpg")
    assert r.status_code == 201
    url = r.json()["thumb_url"]
    assert url.startswith(f"/media/products/{p['id']}/") and ".." not in url


def test_content_decides_not_the_extension_or_content_type(api: TestClient) -> None:
    p = helpers.product(api)
    assert upload(api, p["id"], b"<?php echo 1; ?>", "shell.jpg").status_code == 422
    assert upload(api, p["id"], make_image("PNG"), "actually.txt").status_code == 201


def test_rejections(api: TestClient) -> None:
    p = helpers.product(api)
    cases = {
        "gif": (make_image("GIF"), 422, "IMAGE_UNSUPPORTED"),
        "bmp": (make_image("BMP"), 422, "IMAGE_UNSUPPORTED"),
        "text": (b"hello", 422, "IMAGE_UNSUPPORTED"),
        "empty": (b"", 422, "IMAGE_UNSUPPORTED"),
        "truncated": (make_image()[:300], 422, "IMAGE_UNSUPPORTED"),
        "too big in bytes": (b"\xff" * (10 * 1024 * 1024 + 1), 413, "IMAGE_TOO_LARGE"),
        "pixel bomb": (make_image("PNG", (7000, 7000)), 422, "IMAGE_TOO_BIG_PIXELS"),
    }
    for label, (data, status, code) in cases.items():
        r = upload(api, p["id"], data)
        assert (r.status_code, r.json()["code"]) == (status, code), label


def test_at_most_ten_images_per_product(api: TestClient) -> None:
    p = helpers.product(api)
    img = make_image(size=(40, 40))
    for _ in range(10):
        assert upload(api, p["id"], img).status_code == 201
    r = upload(api, p["id"], img)
    assert r.status_code == 409 and r.json()["code"] == "TOO_MANY_IMAGES"


def test_variant_image_must_belong_to_the_product(api: TestClient) -> None:
    p, other = helpers.product(api), helpers.product(api, "غيره")
    mine, theirs = helpers.variant(api, p["id"]), helpers.variant(api, other["id"])
    ok = upload(api, p["id"], make_image(), variant_id=mine["id"])
    assert ok.status_code == 201 and ok.json()["variant_id"] == mine["id"]
    bad = upload(api, p["id"], make_image(), variant_id=theirs["id"])
    assert bad.status_code == 422
    assert upload(api, "00000000-0000-0000-0000-000000000000", make_image()).status_code == 404


def test_reorder_and_soft_delete(api: TestClient) -> None:
    p = helpers.product(api)
    ids = [upload(api, p["id"], make_image(size=(60 + n, 60))).json()["id"] for n in range(3)]
    moved = api.patch(f"{V1}/products/{p['id']}/images/{ids[2]}", json={"position": 0})
    assert [i["id"] for i in moved.json()] == [ids[2], ids[0], ids[1]]
    assert [i["sort_order"] for i in moved.json()] == [0, 1, 2]

    removed = api.get(f"{V1}/products/{p['id']}").json()["images"][1]
    assert api.delete(f"{V1}/products/{p['id']}/images/{removed['id']}").status_code == 204
    left = api.get(f"{V1}/products/{p['id']}").json()["images"]
    assert [i["id"] for i in left] == [ids[2], ids[1]] and [i["sort_order"] for i in left] == [0, 1]
    assert stored(removed["thumb_url"]).exists()  # files are cleaned up later, not on delete
    assert api.delete(f"{V1}/products/{p['id']}/images/{removed['id']}").status_code == 404


def test_first_image_is_the_list_thumbnail_and_files_are_served(api: TestClient) -> None:
    p = helpers.product(api)
    first = upload(api, p["id"], make_image()).json()
    upload(api, p["id"], make_image(size=(90, 90)))
    item = api.get(V1 + "/products").json()["items"][0]
    assert item["thumb_url"] == first["thumb_url"]
    served = api.get(first["thumb_url"])
    assert served.status_code == 200 and served.headers["content-type"] == "image/webp"
    assert api.get("/media/products/nothing.webp").status_code == 404


def test_variant_images_do_not_become_the_product_thumbnail(api: TestClient) -> None:
    p = helpers.product(api)
    v = helpers.variant(api, p["id"])
    upload(api, p["id"], make_image(), variant_id=v["id"])
    assert api.get(V1 + "/products").json()["items"][0]["thumb_url"] is None
