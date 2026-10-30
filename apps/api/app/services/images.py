"""Product image processing. Flagged for line-by-line review: file upload.

Anything uploaded is decoded by Pillow and re-encoded, so what is stored is always a fresh WebP made
from pixels only: EXIF (including GPS), ICC profiles and any appended data are dropped."""

import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

from app.errors import ApiError

MAX_BYTES = 10 * 1024 * 1024  # SPEC section 13
MAX_PIXELS = 40_000_000  # ~ a 200 MP photo would be refused; a 48 MP phone photo is fine
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
THUMB_SIZE = 400  # SPEC section 3
FULL_SIZE = 1200
MAX_IMAGES_PER_PRODUCT = 10


@dataclass
class ProcessedImage:
    thumb: bytes
    full: bytes


def _encode(im: Image.Image, longest_side: int, quality: int) -> bytes:
    copy = im.copy()
    copy.thumbnail((longest_side, longest_side), Image.Resampling.LANCZOS)  # never enlarges
    out = io.BytesIO()
    copy.save(out, "WEBP", quality=quality, method=4)
    return out.getvalue()


def process_upload(data: bytes) -> ProcessedImage:
    if len(data) > MAX_BYTES:
        raise ApiError(413, "IMAGE_TOO_LARGE", "Image is larger than 10 MB")
    try:
        im = Image.open(io.BytesIO(data))
    except (UnidentifiedImageError, OSError) as exc:
        raise ApiError(
            422, "IMAGE_UNSUPPORTED", "Not a JPEG, PNG or WebP image (HEIC is not supported)"
        ) from exc
    if im.format not in ALLOWED_FORMATS:
        raise ApiError(422, "IMAGE_UNSUPPORTED", "Only JPEG, PNG and WebP images are accepted")
    if im.width * im.height > MAX_PIXELS:  # checked on the header, before any pixels are decoded
        raise ApiError(422, "IMAGE_TOO_BIG_PIXELS", "Image dimensions are too large")
    try:
        im.load()
        upright = ImageOps.exif_transpose(
            im
        )  # the camera's rotation flag, applied before it is dropped
        if upright.mode in ("RGBA", "LA") or (
            upright.mode == "P" and "transparency" in upright.info
        ):
            rgba = upright.convert("RGBA")
            rgb = Image.new("RGB", rgba.size, (255, 255, 255))
            rgb.paste(rgba, mask=rgba.getchannel("A"))
        else:
            rgb = upright.convert("RGB")
    except (OSError, ValueError, SyntaxError) as exc:  # truncated or corrupt file
        raise ApiError(422, "IMAGE_UNSUPPORTED", "The image file is damaged") from exc
    return ProcessedImage(thumb=_encode(rgb, THUMB_SIZE, 65), full=_encode(rgb, FULL_SIZE, 80))
