"""PDF -> text with Baidu Unlimited-OCR (https://github.com/baidu/Unlimited-OCR).

The model runs in the `ocr` service (vLLM, OpenAI-compatible API). Each page is rendered
to a PNG and sent as one chat request, as in the model's vLLM recipe."""
import base64
import re

import httpx
import pymupdf

from config import settings

DPI = 200   # an A4 page becomes ~6 crops of 640px; at 300 DPI it is 24 (too big for an 8 GB GPU)


def pdf_to_text(pdf: bytes) -> str:
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    pages = [ocr_page(doc[i].get_pixmap(dpi=DPI).tobytes("png"))
             for i in range(min(settings.OCR_MAX_PAGES, doc.page_count))]
    return "\n\n".join(pages).strip()


def ocr_page(png: bytes) -> str:
    image = "data:image/png;base64," + base64.b64encode(png).decode()
    resp = httpx.post(f"{settings.OCR_URL}/chat/completions", timeout=600, json={
        "model": "baidu/Unlimited-OCR",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "<image>document parsing."},   # must start with <image>
            {"type": "image_url", "image_url": {"url": image}},
        ]}],
        "temperature": 0,             # no max_tokens: vLLM allows whatever context is left
        "skip_special_tokens": False,
        # the model's no-repeat n-gram logits processor (stops it looping on tables)
        "vllm_xargs": {"ngram_size": 35, "window_size": 128},
    })
    resp.raise_for_status()
    return remove_det(resp.json()["choices"][0]["message"]["content"])


DET_RE = re.compile(r"<\|det\|>([^<\s]+)(?:\s*\[[^\]]*\])?\s*<\|/det\|>(.*)", re.DOTALL)
SKIP = {"image", "footer"}   # footers are boilerplate ("RBI never sends mails ...")


def remove_det(raw: str) -> str:
    """Each block comes as '<|det|>type [bbox]<|/det|>text', maybe followed by more lines.
    Strip the markers, drop SKIP blocks, and put a blank line between blocks
    (adapted from the model's README)."""
    blocks: list[list[str] | None] = []          # None = a skipped block
    for line in raw.splitlines():
        line = line.rstrip()
        if not line:
            continue
        if m := DET_RE.match(line):
            category, content = m.group(1).strip(), m.group(2).strip()
            skip = category in SKIP or content == "[No text]"
            blocks.append(None if skip else [content])
        elif not blocks:
            blocks.append([line])                  # text before the first marker
        elif blocks[-1] is not None:
            blocks[-1].append(line)                # more lines of the current block
    return "\n\n".join("\n".join(b).strip() for b in blocks if b).strip()
