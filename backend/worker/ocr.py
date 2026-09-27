"""PDF -> text with Baidu Unlimited-OCR (https://github.com/baidu/Unlimited-OCR).

The model runs in the `ocr` service (vLLM, OpenAI-compatible API). Each page is rendered
to a PNG and sent as one chat request, following the model's vLLM recipe: the prompt
must start with <image>, no max_tokens is sent (vLLM allows whatever context is left),
and the model's no-repeat n-gram logits processor stops it looping on tables.

Pages are rendered at 200 DPI: an A4 page becomes about 6 crops of 640 px, where 300
DPI gives 24, too many for an 8 GB GPU. All pages go over one reused connection. The
worker saves the result on the circular, so a PDF is only ever OCR'd once."""

import base64
import hashlib
import re

import httpx
import pymupdf

from config import settings

DPI = 200
DET_RE = re.compile(r"<\|det\|>([^<\s]+)(?:\s*\[[^\]]*\])?\s*<\|/det\|>(.*)", re.DOTALL)
SKIP = {"image", "footer"}

client = httpx.Client(timeout=600)
done_pages: dict[str, str] = {}


def pdf_to_text(pdf: bytes) -> str:
    """The text of the first OCR_MAX_PAGES pages, skipping blank ones. Pages already
    read are kept by image hash until the document is done, so if page 15 of 20 times
    out, the retry starts at page 15."""
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    keys, texts = [], []
    for page in doc.pages(0, min(settings.OCR_MAX_PAGES, doc.page_count)):
        if blank(page):
            continue
        png = page.get_pixmap(dpi=DPI).tobytes("png")
        key = hashlib.sha256(png).hexdigest()
        if key not in done_pages:
            done_pages[key] = ocr_page(png)
        keys.append(key)
        texts.append(done_pages[key])
    for key in keys:
        done_pages.pop(key, None)
    return "\n\n".join(t for t in texts if t).strip()


def blank(page: pymupdf.Page) -> bool:
    """Nothing to read: no text layer, no images and no drawings (a separator page)."""
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
    """Each block comes as '<|det|>type [bbox]<|/det|>text', maybe followed by more
    lines. Strip the markers, drop image and footer blocks (footers are boilerplate
    like "RBI never sends mails ...") and empty ones, and put a blank line between
    blocks. A dropped block is kept as None so its continuation lines are dropped
    too. Adapted from the model's README."""
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
