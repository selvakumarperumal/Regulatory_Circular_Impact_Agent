"""Where circulars come from. Each source returns a list of Item."""
import html
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import feedparser
from bs4 import BeautifulSoup

import fetch


@dataclass
class Item:
    source: str
    source_key: str
    title: str
    detail_url: str
    published_at: datetime | None = None


def stable_key(url: str) -> str:
    """Prefer an ID query param (RBI ?Id=, IRDAI ?documentId=); fall back to the path."""
    parsed = urlparse(url)
    params = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
    for name in ("id", "documentid"):
        if name in params:
            return f"{name}={params[name][0]}"
    return parsed.path


IST = timezone(timedelta(hours=5, minutes=30))


def entry_date(e) -> datetime | None:
    if t := e.get("published_parsed") or e.get("updated_parsed"):
        return datetime(*t[:6], tzinfo=timezone.utc)
    try:   # RBI sends "Thu, 24 Sep 2026 17:15:00" with no zone, which feedparser rejects
        return datetime.strptime(e.get("published", ""), "%a, %d %b %Y %H:%M:%S").replace(tzinfo=IST)
    except ValueError:
        return None


def rss_items(source: str, feed_url: str) -> list[Item]:
    feed = feedparser.parse(fetch.get(feed_url).content)
    if not feed.entries:
        raise RuntimeError(f"{source}: feed has no entries; format may have changed")
    items = []
    for e in feed.entries:
        link = (e.get("link") or "").strip()
        if not link:
            continue
        items.append(Item(
            source=source,
            source_key=stable_key(link),
            title=html.unescape((e.get("title") or "").strip()),   # RBI double-escapes, e.g. "&#8377;"
            detail_url=link,
            published_at=entry_date(e),
        ))
    return items


def rbi() -> list[Item]:
    return rss_items("RBI", "https://www.rbi.org.in/notifications_rss.xml")


def sebi() -> list[Item]:
    """SEBI's RSS feed holds only the latest 30 items, mostly orders, so circulars can be
    missing from it. Read the listing pages instead (latest 25 each, newest first)."""
    base = "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&smid=0&ssid="
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
            # circulars: first cell "Sep 09, 2026"; regulations: "2026" + "[Last amended on July 7, 2026]"
            date_text = " ".join(tr.find("td").get_text(" ").split())
            if m := re.search(r"Last amended on (\w+ \d{1,2}, \d{4})", title):
                date_text = m.group(1)
            published = None
            for fmt in ("%b %d, %Y", "%B %d, %Y"):
                try:
                    published = datetime.strptime(date_text, fmt).replace(tzinfo=timezone.utc)
                    break
                except ValueError:
                    pass
            items.append(Item(
                source="SEBI",
                source_key=stable_key(url),
                title=title,
                detail_url=url,
                published_at=published,
            ))
    if not items:
        raise RuntimeError("SEBI: no circular links found; page layout may have changed")
    return items


_DATE_RE = re.compile(r"\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b")


def irdai() -> list[Item]:
    """No RSS, so scrape the listing table. Each row has a document-detail link (stable
    documentId) and a direct link to its own PDF. Links outside the table (site-wide
    forms etc.) are ignored."""
    list_url = "https://irdai.gov.in/circulars"
    soup = BeautifulSoup(fetch.get(list_url).text, "html.parser")
    items = []
    for tr in soup.find_all("tr"):
        detail = tr.find("a", href=re.compile("document-detail"))
        pdfs = [urljoin(list_url, a["href"]) for a in tr.find_all("a", href=True)
                if ".pdf" in a["href"].lower()]
        if not detail or not pdfs:
            continue
        cells = [" ".join(td.get_text(" ").split()) for td in tr.find_all("td")]
        published = None
        if m := _DATE_RE.search(" ".join(cells)):
            d, mth, y = map(int, m.groups())
            try:
                published = datetime(y, mth, d, tzinfo=timezone.utc)
            except ValueError:
                pass
        english = [u for u in pdfs if "hindi" not in u.lower()]
        items.append(Item(
            source="IRDAI",
            source_key=stable_key(urljoin(list_url, detail["href"])),
            title=cells[2] if len(cells) > 2 else cells[-1],   # "Short Description" (col 0 is empty)
            detail_url=(english or pdfs)[0],
            published_at=published,
        ))
    if not items:
        raise RuntimeError("IRDAI: no circular links found; page layout may have changed")
    return items


SOURCES = {"RBI": rbi, "SEBI": sebi, "IRDAI": irdai}


_PDF_RE = re.compile(r"""[^\s"'<>()]+?\.pdf\b""", re.IGNORECASE)


def resolve_pdf_url(item: Item) -> str:
    """Detail pages link to the PDF; pick the first non-Hindi one."""
    if ".pdf" in urlparse(item.detail_url).path.lower():   # direct link (IRDAI: .../x.pdf/<uuid>?download=true)
        return item.detail_url
    html = fetch.get(item.detail_url).text
    links = []
    for m in _PDF_RE.finditer(html):
        # handles viewer wrappers like '../web/?file=https://site/doc.pdf'
        url = urljoin(item.detail_url, unquote(m.group(0)).rsplit("=", 1)[-1])
        if url not in links:
            links.append(url)
    if not links:
        raise LookupError(f"no PDF link on {item.detail_url}")
    english = [u for u in links if "hindi" not in u.lower()]
    return (english or links)[0]
