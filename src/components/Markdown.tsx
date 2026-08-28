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

// A STILL-ARRIVING answer is markdown caught mid-word: "**Getting ready for
// winter" has no closing "**" yet, so renderInline above (which needs both
// halves to match) leaves the raw asterisks on screen until the rest of the
// token lands. Same for a backtick, and for a list marker or heading hash that
// has been written but has no text after it yet.
//
// This closes those open tokens for the length of one paint, so a streaming
// reply reads as the formatted text it is about to be rather than flickering
// through its own syntax. Only used while a reply streams (see `partial`
// below); a FINISHED answer is rendered exactly as it always was, so a stray
// asterisk somebody actually typed still shows as an asterisk.
function closeOpenMarks(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined) return text;

  // A marker with nothing after it yet ("- ", "1.", "###") is one keystroke of
  // syntax, not content: hold it back rather than rendering an empty bullet.
  if (/^\s*(?:[-*]|\d+\.|#{1,6})\s*$/.test(last)) {
    return lines.slice(0, -1).join("\n");
  }

  // Strip the list/heading marker before counting, so "- **warm" counts the
  // bold token and not the bullet's asterisk.
  const body = last.replace(/^\s*(?:[-*]\s+|\d+\.\s+|#{1,6}\s+)/, "");
  let fixed = last;
  if ((body.match(/`/g)?.length ?? 0) % 2 === 1) {
    // An opener with no text after it yet closes onto itself and renders as a
    // pair of literal backticks, so drop it instead of completing it.
    fixed = fixed.endsWith("`") ? fixed.slice(0, -1) : `${fixed}\``;
  }
  if ((body.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    fixed = fixed.endsWith("**") ? fixed.slice(0, -2) : `${fixed}**`;
  } else if (/(^|[^*])\*$/.test(fixed)) {
    // A lone trailing "*" is either an italic that just opened or the first
    // half of a "**" still being typed. Either way it is syntax, not text.
    fixed = fixed.slice(0, -1);
  }

  return [...lines.slice(0, -1), fixed].join("\n");
}

export default function Markdown({
  text,
  partial = false,
}: {
  text: string;
  // True while this text is still being streamed in. See closeOpenMarks.
  partial?: boolean;
}) {
  const source = partial ? closeOpenMarks(text) : text;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
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
