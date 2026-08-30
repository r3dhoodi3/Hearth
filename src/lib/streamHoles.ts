// Test helper, shared by src/components/pro/SetupChecklist.test.tsx and
// src/app/pro/chats/page.test.ts. Pure string work, no app code imports it.
//
// It lives in src/lib rather than inside one of those test files because
// importing a *.test.tsx from another test file would re-register that file's
// suites in the importer, running them twice.
//
// React streams out-of-order content as a hidden `<div id="S:n">` payload plus
// a `<template id="P:n">` hole to drop it into, and a `<script>$RS(...)</script>`
// that does the move. A healthy page has exactly one hole and it sits as a
// DIRECT child of that hidden div. A hole nested deeper - inside a <ul>, a
// <span>, a <section> - means Flight chopped the middle of the page into extra
// rows, which is the shape /pro, /pro/chats and /pro/leads had and the clean
// pro pages did not. See scratchpad/debug-DBG3.md.
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

// The deferrals themselves, which are the CAUSE of those holes and are visible
// even when a fast server resolves every row before Fizz walks past it (in
// which case no template is ever written and nestedStreamHoles sees nothing).
//
// Reassembles the self.__next_f Flight payload out of the document and counts,
// per row, the references to a deferred row. `"$Lxx"` in a VALUE position is a
// deferred element; the same token in an element's TYPE position (`["$","$Lxx"`)
// is an ordinary client-component reference and is not counted.
export function deferredRowRefs(html: string): Record<string, number> {
  const pushRe = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let payload = "";
  let m: RegExpExecArray | null;
  while ((m = pushRe.exec(html))) payload += JSON.parse(m[1]) as string;
  const out: Record<string, number> = {};
  for (const row of payload.split("\n")) {
    const colon = row.indexOf(":");
    if (colon < 0) continue;
    const refs = row.match(/(?<!\["\$",)"\$L[0-9a-f]+"/g);
    if (refs?.length) out[row.slice(0, colon)] = refs.length;
  }
  return out;
}
