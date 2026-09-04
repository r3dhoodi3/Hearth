import Link from "next/link";
import type { ReactNode } from "react";

// A small, dependency-free Markdown renderer for src/content/legal/*.md.
// Handles exactly what those documents use: headings (with anchor ids),
// paragraphs, bold/italic/code, links, one level of nested lists,
// blockquotes, tables, horizontal rules, and a highlighted box for a
// "Plain-language summary:" line or a "## Summary" section. Renders to real
// React elements, never dangerouslySetInnerHTML.

const LINK_CLASS = "text-bark-700 hover:underline dark:text-stone-300";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ParsedLegalDocument {
  title: string;
  lastUpdated: string;
  headings: { id: string; text: string }[];
  body: string;
}

// Pulls the "# Title" and "Last updated: ..." lines off the top of a legal
// doc so the page chrome can render its own <h1>, and collects every "##"
// heading (with its anchor id) for the table of contents.
export function parseLegalDocument(raw: string): ParsedLegalDocument {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let idx = 0;
  let title = "";
  const titleMatch = lines[idx]?.match(/^#\s+(.*)$/);
  if (titleMatch) {
    title = titleMatch[1].trim();
    idx++;
  }
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  let lastUpdated = "";
  const dateMatch = lines[idx]?.match(/^Last updated:\s*(.*)$/i);
  if (dateMatch) {
    lastUpdated = dateMatch[1].trim();
    idx++;
  }
  const body = lines.slice(idx).join("\n").replace(/^\n+/, "");
  const headings: { id: string; text: string }[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) headings.push({ id: slugify(m[1].trim()), text: m[1].trim() });
  }
  return { title, lastUpdated, headings, body };
}

export function renderLegalMarkdown(markdown: string): ReactNode {
  return <>{renderBlocks(markdown.replace(/\r\n/g, "\n").split("\n"))}</>;
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) ||
    /^>/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line)
  );
}

function renderBlocks(lines: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      nodes.push(renderHeading(level, text, key++));
      i++;
      // A "## Summary" section (the plain-language summary box at the top
      // of the longer documents) gets everything up to the next "##"
      // heading wrapped in a highlighted box.
      if (level === 2 && /^summary\b/i.test(text)) {
        let j = i;
        while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
        nodes.push(
          <div key={key++} className={HIGHLIGHT_CLASS}>{renderBlocks(lines.slice(i, j))}</div>
        );
        i = j;
      }
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      nodes.push(<hr key={key++} className="mt-6 border-stone-200 dark:border-stone-700" />);
      i++;
      continue;
    }

    if (/^>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      nodes.push(
        <blockquote key={key++} className="mt-3 border-l-4 border-stone-300 pl-4 italic leading-relaxed text-stone-600 dark:border-stone-600 dark:text-stone-400">
          {parseInline(quoted.join(" "))}
        </blockquote>
      );
      continue;
    }

    if (
      line.trim().startsWith("|") &&
      lines[i + 1] !== undefined &&
      /^[\s|:-]+$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }
      nodes.push(renderTable(tableLines, key++));
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const listLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        (/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))
      ) {
        listLines.push(lines[i]);
        i++;
      }
      nodes.push(renderList(parseListBlock(listLines), key++));
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(renderParagraph(paraLines.join(" ").trim(), key++));
  }

  return nodes;
}

function renderHeading(level: number, text: string, key: number): ReactNode {
  const id = slugify(text);
  const content = parseInline(text);
  return level === 3 ? (
    <h3 key={key} id={id} className="mt-5 font-semibold text-stone-900 dark:text-stone-100">{content}</h3>
  ) : (
    <h2 key={key} id={id} className="mt-8 text-lg font-semibold text-stone-900 dark:text-stone-100">{content}</h2>
  );
}

const HIGHLIGHT_CLASS =
  "mt-4 rounded-md border border-stone-300 bg-stone-50 p-4 leading-relaxed dark:border-stone-700 dark:bg-stone-800";

function renderParagraph(text: string, key: number): ReactNode {
  if (/^\*\*Plain-language summary:\*\*/.test(text)) {
    return <div key={key} className={HIGHLIGHT_CLASS}>{parseInline(text)}</div>;
  }
  return <p key={key} className="mt-3 leading-relaxed">{parseInline(text)}</p>;
}

function renderTable(lines: string[], key: number): ReactNode {
  const splitRow = (l: string) =>
    l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const header = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return (
    <div key={key} className="mt-4 overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-700">
      <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
        <thead className="bg-stone-50 text-stone-900 dark:bg-stone-800 dark:text-stone-100">
          <tr>
            {header.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 align-top font-semibold">{parseInline(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 align-top">{parseInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ListNode {
  ordered: boolean;
  items: { content: string; sub?: ListNode }[];
}

// One level of nesting: an indented line (2+ spaces) attaches to whichever
// top-level item came before it, and its own lines are parsed as a sub-list.
function parseListBlock(rawLines: string[]): ListNode {
  const top: { content: string; subLines: string[] }[] = [];
  let ordered = false;
  for (const raw of rawLines) {
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    const line = raw.slice(indent);
    if (indent === 0) {
      const unordered = line.match(/^[-*+]\s+(.*)$/);
      const numbered = line.match(/^\d+\.\s+(.*)$/);
      if (unordered) {
        top.push({ content: unordered[1], subLines: [] });
      } else if (numbered) {
        ordered = true;
        top.push({ content: numbered[1], subLines: [] });
      } else if (top.length) {
        top[top.length - 1].content += ` ${line}`;
      }
    } else if (top.length) {
      top[top.length - 1].subLines.push(line);
    }
  }
  return {
    ordered,
    items: top.map((t) => ({
      content: t.content,
      sub: t.subLines.length ? parseListBlock(t.subLines) : undefined,
    })),
  };
}

function renderList(list: ListNode, key: number): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={i}>
      {parseInline(item.content)}
      {item.sub ? renderList(item.sub, i) : null}
    </li>
  ));
  return list.ordered ? (
    <ol key={key} className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
      {items}
    </ol>
  ) : (
    <ul key={key} className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
      {items}
    </ul>
  );
}

// Only these schemes ever become a clickable link. The renderer only ever sees
// repo-controlled markdown, but a scheme allowlist costs nothing and means a
// stray "javascript:" or "data:" URL in a future edit renders as plain text
// instead of a link.
const SAFE_EXTERNAL_HREF = /^(https?:\/\/|mailto:)/i;

function renderLink(text: string, href: string, key: number): ReactNode {
  // A protocol-relative "//host" (or "/\\host", which some browsers fold into
  // "//host") is an off-site URL, not an internal path, so it must go through
  // the scheme allowlist below instead of becoming a bare <Link>.
  const isInternal = /^(\/(?![\/\\])|#)/.test(href);
  if (isInternal) {
    return (
      <Link key={key} href={href} className={LINK_CLASS}>{text}</Link>
    );
  }
  if (!SAFE_EXTERNAL_HREF.test(href)) {
    return <span key={key}>{text}</span>;
  }
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{text}</a>
  );
}

// Order matters: code spans first (so markup inside them is never parsed),
// then links, then bold, then italic. A fresh regex per call keeps recursive
// calls (bold containing italic, etc.) from corrupting each other's lastIndex.
function parseInline(text: string): ReactNode[] {
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-stone-100 px-1 py-0.5 text-[0.9em] dark:bg-stone-800">{match[1]}</code>
      );
    } else if (match[2] !== undefined) {
      nodes.push(renderLink(match[2], match[3], key++));
    } else if (match[4] !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold text-stone-900 dark:text-stone-100">{parseInline(match[4])}</strong>
      );
    } else if (match[5] !== undefined) {
      nodes.push(<em key={key++}>{parseInline(match[5])}</em>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
