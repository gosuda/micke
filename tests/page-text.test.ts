// tests/page-text.test.ts — the content path's parser, without a browser.
//
// micke-page-text shells out to chromium; the extraction itself lives in
// image/page_text.py and is pure, so it is tested here against a fixture HTML
// string: title, block-ordered text, script/style exclusion, link resolution,
// and --max-chars truncation.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PARSER = join(import.meta.dir, "..", "image", "page_text.py");

function run(args: string[], html?: string): { rc: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "micke-pagetext-"));
  try {
    const argv = ["python3", PARSER, ...args];
    if (html !== undefined) {
      const file = join(dir, "page.html");
      writeFileSync(file, html);
      argv.push("--html", file);
    }
    const proc = Bun.spawnSync(argv);
    return {
      rc: proc.exitCode ?? 1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE = `<!doctype html>
<html><head>
  <title>  Example &amp; News  </title>
  <style>body { color: red }</style>
  <script>window.__noise__ = "not content";</script>
</head>
<body>
  <nav><a href="/home">Home</a></nav>
  <h1>Top story</h1>
  <p>First   paragraph with
     wrapped text.</p>
  <p>Second paragraph.</p>
  <script type="application/json">{"ignored": true}</script>
  <div><a href="https://example.com/a">Read more</a></div>
  <a href="#anchor">Skip me</a>
  <a href="javascript:void(0)">Skip me too</a>
</body></html>`;

describe("page_text extraction", () => {
  test("title, block-ordered text, noise excluded", () => {
    const r = run(["--url", "https://example.com/news/"], FIXTURE);
    expect(r.rc).toBe(0);

    const doc = JSON.parse(r.stdout);
    expect(doc.title).toBe("Example & News");
    expect(doc.url).toBe("https://example.com/news/");

    const text: string = doc.text;
    expect(text).toContain("Top story");
    expect(text).toContain("First paragraph with wrapped text.");
    expect(text).toContain("Second paragraph.");
    expect(text).not.toContain("not content");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("ignored");

    // Document order survives: heading before paragraph before link text.
    expect(text.indexOf("Top story")).toBeLessThan(text.indexOf("First paragraph"));
    expect(text.indexOf("First paragraph")).toBeLessThan(text.indexOf("Second paragraph"));
    expect(text.indexOf("Second paragraph")).toBeLessThan(text.indexOf("Read more"));

    expect(doc.chars).toBe(text.length);
    expect(doc.truncated).toBe(false);
    expect(doc.links).toBeUndefined(); // --links was not requested
  });

  test("--links resolves relative hrefs and drops non-links", () => {
    const r = run(["--url", "https://example.com/news/", "--links"], FIXTURE);
    const doc = JSON.parse(r.stdout);

    expect(doc.links).toContainEqual({ text: "Home", href: "https://example.com/home" });
    expect(doc.links).toContainEqual({ text: "Read more", href: "https://example.com/a" });
    expect(doc.links.map((l: any) => l.text)).not.toContain("Skip me");
    expect(doc.links.map((l: any) => l.text)).not.toContain("Skip me too");
  });

  test("--max-chars truncates but reports the full length", () => {
    const r = run(["--max-chars", "20"], FIXTURE);
    const doc = JSON.parse(r.stdout);

    expect(doc.truncated).toBe(true);
    expect(doc.text.endsWith("…")).toBe(true);
    expect(doc.text.length).toBeLessThanOrEqual(21);
    expect(doc.chars).toBeGreaterThan(20);
  });

  test("empty input is an error, not an empty document", () => {
    const r = run([], "   ");
    expect(r.rc).toBe(2);
    expect(r.stderr).toContain("empty HTML input");
  });
});
