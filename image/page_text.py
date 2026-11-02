#!/usr/bin/env python3
"""page_text — turn a dumped DOM into small, agent-readable JSON.

The AT-SPI tree is the *interaction* path; this is the *content* path. It reads
the HTML produced by `chromium --headless --dump-dom` (or any file on stdin)
and emits one compact JSON object:

    {"url": ..., "title": ..., "text": ..., "links": [...],
     "chars": N, "truncated": false}

Deliberately stdlib-only: python3 is already a core dependency of the image.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin

# Elements whose text is never page content.
SKIP = {
    "script", "style", "noscript", "template", "svg", "canvas", "iframe",
    "object", "embed",
}

# Elements that end a line of text (so paragraphs do not run together).
BLOCK = {
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
    "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
    "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
    "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "ul",
}

_WS = re.compile(r"[ \t\r\f\v\n]+")

# Synthetic block boundary: never produced by page text, so a newline inside
# source HTML (which is just whitespace) cannot be mistaken for a line break.
BREAK = "\x00"


class Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.chunks: list[str] = []
        self.title_parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._skip = 0
        self._in_title = False
        self._anchor: dict | None = None

    # -- helpers ---------------------------------------------------------
    def _emit(self, text: str) -> None:
        if self._skip:
            return
        if self._anchor is not None:
            self._anchor["parts"].append(text)
        self.chunks.append(text)

    def _break(self) -> None:
        if not self._skip:
            self.chunks.append(BREAK)

    # -- HTMLParser hooks ------------------------------------------------
    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in SKIP:
            self._skip += 1
            return
        if tag == "title":
            self._in_title = True
            return
        if self._skip:
            return
        if tag in BLOCK:
            self._break()
        if tag == "a":
            if self._anchor is None:
                href = dict(attrs).get("href") or ""
                self._anchor = {"href": href, "parts": []}

    def handle_startendtag(self, tag: str, attrs) -> None:
        # <br/>, <hr/>: block-level line breaks with no matching end tag.
        tag = tag.lower()
        if tag in SKIP or self._skip:
            return
        if tag in BLOCK:
            self._break()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in SKIP:
            if self._skip:
                self._skip -= 1
            return
        if tag == "title":
            self._in_title = False
            return
        if self._skip:
            return
        if tag == "a" and self._anchor is not None:
            text = _normalize_inline(" ".join(self._anchor["parts"]))
            if text:
                self.links.append((text, self._anchor["href"]))
            self._anchor = None
        if tag in BLOCK:
            self._break()

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self._in_title:
            self.title_parts.append(data)
            return
        self._emit(data)


def _normalize_inline(s: str) -> str:
    return _WS.sub(" ", s).strip()


def normalize_text(chunks: list[str]) -> str:
    """Collapse inline whitespace, keep one newline per visual block.

    Source HTML newlines inside a paragraph are whitespace (they collapse);
    only block elements emit BREAK, so paragraphs never get split by a
    pretty-printed source file.
    """
    out: list[str] = []
    for segment in "".join(chunks).split(BREAK):
        line = _normalize_inline(segment)
        if line:
            out.append(line)
        elif out and out[-1] != "":
            # Preserve a blank line between blocks, not runs of them.
            out.append("")
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)


def extract(html: str, base_url: str) -> dict:
    parser = Extractor()
    parser.feed(html)
    parser.close()

    title = _normalize_inline(" ".join(parser.title_parts))
    text = normalize_text(parser.chunks)

    links: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for link_text, href in parser.links:
        href = href.strip()
        if not href or href.startswith(("javascript:", "#")):
            continue
        if base_url:
            href = urljoin(base_url, href)
        key = (link_text, href)
        if key in seen:
            continue
        seen.add(key)
        links.append({"text": link_text, "href": href})

    return {"title": title, "text": text, "links": links}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog="page_text",
        description="Turn dumped HTML into compact JSON for agents.",
    )
    ap.add_argument("--url", default="", help="Page URL (recorded and used to resolve relative links).")
    ap.add_argument("--html", help="Read HTML from this file instead of stdin.")
    ap.add_argument("--max-chars", type=int, default=20000, help="Truncate text at N characters (default 20000; 0 disables).")
    ap.add_argument("--links", action="store_true", help="Include the link list.")
    ap.add_argument("--pretty", action="store_true", help="Indent the JSON (default: one line).")
    args = ap.parse_args(argv)

    try:
        if args.html:
            with open(args.html, "r", encoding="utf-8", errors="replace") as fh:
                html = fh.read()
        else:
            html = sys.stdin.read()
    except OSError as err:
        print(f"page_text: cannot read HTML: {err}", file=sys.stderr)
        return 2

    if not html.strip():
        print("page_text: empty HTML input", file=sys.stderr)
        return 2

    doc = extract(html, args.url)
    full_chars = len(doc["text"])
    truncated = False
    if args.max_chars > 0 and full_chars > args.max_chars:
        doc["text"] = doc["text"][: args.max_chars].rstrip() + "…"
        truncated = True

    result = {
        "url": args.url,
        "title": doc["title"],
        "text": doc["text"],
        "chars": full_chars,
        "truncated": truncated,
    }
    if args.links:
        result["links"] = doc["links"]

    indent = 2 if args.pretty else None
    json.dump(result, sys.stdout, ensure_ascii=False, indent=indent)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
