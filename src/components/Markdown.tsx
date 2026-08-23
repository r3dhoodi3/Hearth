import React from "react";

// A tiny, dependency-free renderer for the markdown the model returns, so Ask
// Hearth answers show as real bold text and bullet/numbered lists instead of
// literal "**", "-", and "#" characters. Handles the common cases only:
// **bold**, *italic*, `code`, "- "/"* " bullets, "1." lists, "#" headings,
// and blank-line paragraph breaks. Plain text, no HTML injection.

// Inline: **bold**, *italic*, `code`. Returns an array of React nodes.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on the three inline tokens, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyBase}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-stone-100 px-1 text-[0.85em] text-stone-800 dark:bg-stone-600 dark:text-stone-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else {
      nodes.push(<React.Fragment key={key}>{part}</React.Fragment>);
    }
  });
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i}>{renderInline(it, `li-${key}-${i}`)}</li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="ml-4 list-decimal space-y-1.5">
          {items}
        </ol>
      ) : (
        <ul key={key++} className="ml-4 list-disc space-y-1.5">
          {items}
        </ul>
      )
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);

    if (bullet) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
    } else if (numbered) {
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(numbered[1]);
    } else if (heading) {
      flushList();
      blocks.push(
        <p key={key++} className="font-semibold text-stone-900 dark:text-stone-100">
          {renderInline(heading[1], `h-${key}`)}
        </p>
      );
    } else {
      flushList();
      blocks.push(<p key={key++}>{renderInline(line, `p-${key}`)}</p>);
    }
  }
  flushList();

  // Generous vertical rhythm + relaxed line-height so answers read as calm,
  // airy paragraphs instead of a dense wall of text.
  return <div className="space-y-3 leading-relaxed">{blocks}</div>;
}
