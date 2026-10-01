"""PDF pages -> text with Baidu Unlimited-OCR, served by vLLM in the ocr service. Each
page is rendered at 200 DPI (an A4 page is ~6 crops; 300 DPI is too many for an 8 GB
GPU) and sent as one chat request, following the model's vLLM recipe."""

import base64
import re
from collections.abc import Container, Iterator

import httpx
import pymupdf

from config import settings

DPI = 200
DET_RE = re.compile(r"<\|det\|>([^<\s]+)(?:\s*\[[^\]]*\])?\s*<\|/det\|>(.*)", re.DOTALL)
SKIP = {"image", "footer"}

client = httpx.Client(timeout=600)


def pages(pdf: bytes, skip: Container[int] = ()) -> Iterator[tuple[int, str]]:
    """(page number, text) for each of the first OCR_MAX_PAGES pages not in `skip`,
    the moment it's read. A blank page isn't sent: its text is ""."""
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    for n in range(min(settings.OCR_MAX_PAGES, doc.page_count)):
        if n in skip:
            continue
        page = doc[n]
        png = None if blank(page) else page.get_pixmap(dpi=DPI).tobytes("png")
        yield n, ocr_page(png) if png else ""


def blank(page: pymupdf.Page) -> bool:
    """No text, images or drawings: a separator page."""
    return (
        not page.get_text().strip()
        and not page.get_images()
        and not page.get_drawings()
    )


def ocr_page(png: bytes) -> str:
    image = "data:image/png;base64," + base64.b64encode(png).decode()
    resp = client.post(
        f"{settings.OCR_URL}/chat/completions",
        json={
            "model": "baidu/Unlimited-OCR",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "<image>document parsing."},
                        {"type": "image_url", "image_url": {"url": image}},
                    ],
                }
            ],
            "temperature": 0,
            "skip_special_tokens": False,
            "vllm_xargs": {"ngram_size": 35, "window_size": 128},
        },
    )
    resp.raise_for_status()
    return remove_det(resp.json()["choices"][0]["message"]["content"])


def remove_det(raw: str) -> str:
    """Blocks come as '<|det|>type [bbox]<|/det|>text' plus continuation lines. Keep
    the text, drop image, footer and empty blocks (with their continuation lines)."""
    blocks: list[list[str] | None] = []
    for line in raw.splitlines():
        line = line.rstrip()
        if not line:
            continue
        if m := DET_RE.match(line):
            category, content = m.group(1).strip(), m.group(2).strip()
            dropped = category in SKIP or content == "[No text]"
            blocks.append(None if dropped else [content])
        elif not blocks:
            blocks.append([line])
        elif blocks[-1] is not None:
            blocks[-1].append(line)
    return "\n\n".join("\n".join(b).strip() for b in blocks if b).strip()
