"""Check rendered local links, assets, fragments, and Pages base paths without network access."""

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
import sys


SITE = Path(__file__).resolve().parents[2] / "site"
ORIGIN = "https://voc0der.github.io"
BASE = "/ytdl-material/"


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.ids = set()
        self.links = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "a" and "name" in attrs:
            self.ids.add(attrs["name"])
        attribute = "href" if tag in {"a", "link"} else "src" if tag in {"img", "script", "source"} else None
        if attribute and attrs.get(attribute):
            self.links.append(attrs[attribute])


pages = {path: Page(path.read_text()) for path in SITE.rglob("*.html")}
if not pages or not (SITE / "index.html").is_file():
    sys.exit("No built site found. Run zensical build --clean --strict first.")

errors = []
checked = 0
for path, page in pages.items():
    relative = path.relative_to(SITE).as_posix()
    current = ORIGIN + BASE + relative.removesuffix("index.html")
    for link in page.links:
        parsed = urlsplit(urljoin(current, link))
        if parsed.scheme not in {"http", "https"} or parsed.netloc != urlsplit(ORIGIN).netloc:
            continue
        if not parsed.path.startswith(BASE):
            errors.append(f"{relative}: link escapes the Pages project path: {link}")
            continue
        target = SITE / unquote(parsed.path.removeprefix(BASE))
        if target.is_dir():
            target /= "index.html"
        checked += 1
        if not target.is_file():
            errors.append(f"{relative}: missing target: {link}")
        elif parsed.fragment and target.suffix == ".html":
            target_page = pages.get(target)
            if target_page and unquote(parsed.fragment) not in target_page.ids:
                errors.append(f"{relative}: missing fragment: {link}")

if errors:
    sys.exit("\n".join(sorted(set(errors))))
print(f"Checked {checked} local links and assets across {len(pages)} HTML pages, including fragments and the Pages base path.")
