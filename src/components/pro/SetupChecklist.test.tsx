// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import SetupChecklist, { type SetupItem } from "./SetupChecklist";

afterEach(() => {
  cleanup();
});

const item = (over: Partial<SetupItem> = {}): SetupItem => ({
  label: "Put your license on file",
  done: false,
  href: "/pro/profile",
  linkLabel: "Add license",
  ...over,
});

describe("SetupChecklist", () => {
  it("counts only the steps the pro can finish", () => {
    render(
      <SetupChecklist
        items={[
          item({ label: "a", done: true }),
          item({ label: "b" }),
          item({ label: "c", optional: true }),
        ]}
      />
    );
    // Two countable steps, one of them done. The optional row still shows but
    // is out of the count, so an unfinishable step cannot pin the card open.
    expect(screen.getByText("1 of 2 done")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
  });

  it("renders nothing once every countable step is done", () => {
    const { container } = render(
      <SetupChecklist
        items={[item({ label: "a", done: true }), item({ label: "b", optional: true })]}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("links only the steps that are still open", () => {
    render(
      <SetupChecklist
        items={[
          item({ label: "a", done: true, linkLabel: "Done thing" }),
          item({ label: "b", linkLabel: "Open thing", href: "/pro/profile#reviews" }),
        ]}
      />
    );
    expect(screen.queryByText(/Done thing/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open thing/ })).toHaveAttribute(
      "href",
      "/pro/profile#reviews"
    );
  });
});

// The regression this file exists for. See the long comment at the top of
// SetupChecklist.tsx: as a SERVER component this checklist sat at the tail of
// the pro Home tab's Flight row, past the point where React starts deferring
// elements into their own rows, and every deferred row became an out-of-order
// SSR stream segment - a `<template id="P:n">` placeholder in the flushed
// markup plus a late `$RS(...)` script to fill it. /pro carried eight of those
// against the one that every healthy pro page has, and it is the only
// structural difference between the pro pages that throw a hydration error on
// load and the ones that do not.
//
// A unit test cannot see a stream, so this asserts the property that keeps the
// stream shape: the module is a client module.
describe("SetupChecklist stays a client component", () => {
  it("carries the \"use client\" directive", () => {
    // Read from the repo root rather than import.meta.url: under the jsdom
    // environment this file's import.meta.url is not a file: URL.
    const src = readFileSync(
      join(process.cwd(), "src/components/pro/SetupChecklist.tsx"),
      "utf8"
    );
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });
});

// The shape check DBG2 asked for, as a reusable function so it can be proved
// to discriminate (below) and then pointed at a real server (below that).
//
// React streams out-of-order content as a hidden `<div id="S:n">` payload plus
// a `<template id="P:n">` hole to drop it into, and a `<script>$RS(...)</script>`
// that does the move. A healthy page has exactly one hole and it sits as a
// DIRECT child of that hidden div. A hole nested deeper - inside a <ul>, a
// <span>, a <section> - means Flight chopped the middle of the page into extra
// rows, which is the shape /pro and /pro/leads had and the clean pro pages did
// not.
export function nestedStreamHoles(html: string): string[] {
  const VOID = new Set(
    "area base br col embed hr img input link meta param source track wbr".split(" ")
  );
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack: { tag: string; attrs: string }[] = [];
  const nested: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosing = m[4] === "/";
    if (!closing && tag === "template") {
      const id = (attrs.match(/id="([^"]*)"/) ?? [])[1] ?? "";
      const parent = stack[stack.length - 1];
      if (id.startsWith("P:") && !(parent && /id="S:[0-9a-f]+"/.test(parent.attrs))) {
        nested.push(id);
      }
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (!selfClosing && !VOID.has(tag)) {
      stack.push({ tag, attrs });
    }
  }
  return nested;
}

describe("nestedStreamHoles", () => {
  it("accepts the healthy shape: one hole, direct child of the hidden payload", () => {
    const healthy =
      '<body><main><!--$?--><template id="B:0"></template></main>' +
      '<div hidden id="S:0"><template id="P:2"></template></div></body>';
    expect(nestedStreamHoles(healthy)).toEqual([]);
  });

  it("flags the shape /pro had: holes chopped into the page's own markup", () => {
    const broken =
      '<body><div hidden id="S:2"><section class="card"><ul class="space-y-2">' +
      '<li><span><template id="P:3"></template></span></li>' +
      '<template id="P:5"></template></ul></section></div></body>';
    expect(nestedStreamHoles(broken)).toEqual(["P:3", "P:5"]);
  });
});

// The same check against a real streamed response. It needs a running server
// and a signed-in pro cookie, so it is opt-in:
//
//   HEARTH_STREAM_CHECK_URL=http://localhost:3103/pro //   HEARTH_STREAM_CHECK_COOKIE='sb-...' npx vitest run src/components/pro/SetupChecklist.test.tsx
const streamUrl = process.env.HEARTH_STREAM_CHECK_URL;

describe.skipIf(!streamUrl)("served HTML has no nested stream holes", () => {
  it("keeps every <template id=\"P:\"> a direct child of a hidden segment", async () => {
    const res = await fetch(streamUrl as string, {
      headers: { cookie: process.env.HEARTH_STREAM_CHECK_COOKIE ?? "" },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
  });
});
