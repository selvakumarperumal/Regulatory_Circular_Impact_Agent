"""Where circulars come from. Each source returns a list of Item.

- RBI: the notifications RSS feed. It sends dates like "Thu, 24 Sep 2026 17:15:00"
  with no zone (IST), which feedparser rejects, and double-escapes titles (e.g.
  "&#8377;").
- SEBI: the listing pages, since the RSS feed misses many circulars.
- IRDAI: the circulars table; each row links its own PDF."""

import html
import re
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import feedparser
from bs4 import BeautifulSoup

import fetch

IST = timezone(timedelta(hours=5, minutes=30))
DMY_RE = re.compile(r"\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b")
PDF_RE = re.compile(r"""[^\s"'<>()]+?\.pdf\b""", re.IGNORECASE)


@dataclass
class Item:
    source: str
    source_key: str
    title: str
    detail_url: str
    published_at: datetime | None = None


def stable_key(url: str) -> str:
    """An ID query param (RBI ?Id=, IRDAI ?documentId=), or else the path."""
    parsed = urlparse(url)
    params = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
    for name in ("id", "documentid"):
        if name in params:
            return f"{name}={params[name][0]}"
    return parsed.path


def entry_date(e) -> datetime | None:
    if t := e.get("published_parsed") or e.get("updated_parsed"):
        return datetime(*t[:6], tzinfo=UTC)
    try:
        return datetime.strptime(
            e.get("published", ""), "%a, %d %b %Y %H:%M:%S"
        ).replace(tzinfo=IST)
    except ValueError:
        return None


def rss_items(source: str, feed_url: str) -> list[Item]:
    feed = feedparser.parse(fetch.get(feed_url).content)
    if not feed.entries:
        raise RuntimeError(f"{source}: feed has no entries; format may have changed")
    return [
        Item(
            source=source,
            source_key=stable_key(link),
            title=html.unescape((e.get("title") or "").strip()),
            detail_url=link,
            published_at=entry_date(e),
        )
        for e in feed.entries
        if (link := (e.get("link") or "").strip())
    ]


def rbi() -> list[Item]:
    return rss_items("RBI", "https://www.rbi.org.in/notifications_rss.xml")


def sebi_date(row_date: str, title: str) -> datetime | None:
    """Circulars have "Sep 09, 2026" in their first cell; regulations have just the
    year there, and "[Last amended on July 7, 2026]" in the title."""
    if m := re.search(r"Last amended on (\w+ \d{1,2}, \d{4})", title):
        row_date = m.group(1)
    for fmt in ("%b %d, %Y", "%B %d, %Y"):
        with suppress(ValueError):
            return datetime.strptime(row_date, fmt).replace(tzinfo=UTC)
    return None


def sebi() -> list[Item]:
    """SEBI's RSS feed holds only the latest 30 items, mostly orders, so circulars
    can be missing from it. Read the listing pages instead (latest 25 each, newest
    first)."""
    base = (
        "https://www.sebi.gov.in/sebiweb/home/HomeAction.do"
        "?doListing=yes&sid=1&smid=0&ssid="
    )
    pages = {7: "circulars", 6: "master-circulars", 3: "regulations"}
    items = []
    for ssid, kind in pages.items():
        list_url = base + str(ssid)
        soup = BeautifulSoup(fetch.get(list_url).text, "html.parser")
        for tr in soup.find_all("tr"):
            a = tr.find("a", href=re.compile(f"/legal/{kind}/"))
            if not a:
                continue
            url = urljoin(list_url, a["href"])
            title = a.get("title") or " ".join(a.get_text(" ").split())
            row_date = " ".join(tr.find("td").get_text(" ").split())
            items.append(
                Item(
                    source="SEBI",
                    source_key=stable_key(url),
                    title=title,
                    detail_url=url,
                    published_at=sebi_date(row_date, title),
                )
            )
    if not items:
        raise RuntimeError(
            "SEBI: no circular links found; page layout may have changed"
        )
    return items


def irdai_date(cells: list[str]) -> datetime | None:
    if m := DMY_RE.search(" ".join(cells)):
        day, month, year = map(int, m.groups())
        with suppress(ValueError):
            return datetime(year, month, day, tzinfo=UTC)
    return None


def irdai() -> list[Item]:
    """No RSS, so scrape the listing table. Each row has a document-detail link
    (stable documentId) and a direct link to its own PDF. Links outside the table
    (site-wide forms etc.) are ignored. The title is the "Short Description" column
    (the first is empty)."""
    list_url = "https://irdai.gov.in/circulars"
    soup = BeautifulSoup(fetch.get(list_url).text, "html.parser")
    items = []
    for tr in soup.find_all("tr"):
        detail = tr.find("a", href=re.compile("document-detail"))
        pdfs = [
            urljoin(list_url, a["href"])
            for a in tr.find_all("a", href=True)
            if ".pdf" in a["href"].lower()
        ]
        if not detail or not pdfs:
            continue
        cells = [" ".join(td.get_text(" ").split()) for td in tr.find_all("td")]
        english = [u for u in pdfs if "hindi" not in u.lower()]
        items.append(
            Item(
                source="IRDAI",
                source_key=stable_key(urljoin(list_url, detail["href"])),
                title=cells[2] if len(cells) > 2 else cells[-1],
                detail_url=(english or pdfs)[0],
                published_at=irdai_date(cells),
            )
        )
    if not items:
        raise RuntimeError(
            "IRDAI: no circular links found; page layout may have changed"
        )
    return items


SOURCES = {"RBI": rbi, "SEBI": sebi, "IRDAI": irdai}


def resolve_pdf_url(item: Item) -> str:
    """The circular's PDF: the detail URL itself when it's a direct link (IRDAI's
    look like .../x.pdf/<uuid>?download=true), otherwise the first non-Hindi PDF
    linked from the detail page. Viewer wrappers like
    '../web/?file=https://site/doc.pdf' are unwrapped."""
    if ".pdf" in urlparse(item.detail_url).path.lower():
        return item.detail_url
    page = fetch.get(item.detail_url).text
    links = []
    for m in PDF_RE.finditer(page):
        url = urljoin(item.detail_url, unquote(m.group(0)).rsplit("=", 1)[-1])
        if url not in links:
            links.append(url)
    if not links:
        raise LookupError(f"no PDF link on {item.detail_url}")
    english = [u for u in links if "hindi" not in u.lower()]
    return (english or links)[0]
