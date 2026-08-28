// One-line previews of message text, for conversation lists and notifications.
//
// Assistant replies are STORED with everything the chat bubble knows how to
// render: markdown emphasis, and the machine-readable [[TAG]]{...}[[/TAG]]
// blocks the assistant appends for actions (POSTJOB, LOGISSUE, REMINDER,
// OPTIONS). The bubble strips those before rendering (parseAssistant in
// src/components/AskHearth.tsx). The Messages list did not, so the pinned
// Ask Hearth row showed a preview reading
// `**Here's what I'd do:** [[OPTIONS]]{"options":["Call a pro"]}[[/OPTIONS]]`.
//
// parseAssistant itself is not reusable here: it lives in a "use client"
// React component, so importing it into a server component would drag React
// and the whole chat UI along. This is the small, dependency-free version -
// display only, no JSON parsing, no action extraction.
//
// Pure, no I/O, no React: server components and the browser both import it.

// The default preview ceiling. A conversation row truncates with CSS anyway;
// this is about not carrying kilobytes of an answer into the markup for a line
// that shows forty characters.
export const PREVIEW_MAX_CHARS = 140;

// Strips a well-formed [[TAG]]...[[/TAG]] block, a stray opening or closing
// marker, and an UNTERMINATED opener at the end of a truncated reply ("[[OPTI").
// Same three rules, in the same order, as parseAssistant's safety net.
function stripMachineBlocks(text: string): string {
  return text
    .replace(/\[\[[A-Za-z/]+\]\][\s\S]*?\[\[\/?[^\]]*\]\]/g, " ")
    .replace(/\[\[\/?[^\]]*\]\]/g, " ")
    .replace(/\[\[(?:(?!\]\])[\s\S])*$/, " ");
}

// Basic markdown, reduced to the words inside it. Not a parser: a preview only
// has to stop the punctuation showing, and anything clever here would be a
// second renderer to keep in step with src/components/Markdown.tsx.
function stripMarkdown(text: string): string {
  return (
    text
      // Fenced and inline code, keeping the code itself.
      .replace(/```+[a-z]*\n?/gi, " ")
      .replace(/`+/g, "")
      // Links and images: keep the label, drop the target.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis markers. Applied to the marker itself rather than matched as
      // pairs, so an unclosed "**" from a still-streaming reply is handled too.
      .replace(/[*_]{1,3}/g, "")
      // Headings, blockquotes and horizontal rules, at the start of any line.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, " ")
      // List markers: "- ", "* ", "1. ". Only at the start of a line, so a
      // hyphen inside a sentence survives.
      .replace(/^\s{0,3}[-*+]\s+/gm, "")
      .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
  );
}

// The one-line, human-readable form of a stored message body.
//
// Returns "" for a body with nothing left to show (a reply that was only an
// OPTIONS block, an empty string, a null). Callers already have a fallback for
// an empty preview - a job category, "Photo" - so an empty string here is a
// real answer, not a failure.
export function plainPreview(
  text: string | null | undefined,
  maxChars: number = PREVIEW_MAX_CHARS
): string {
  if (typeof text !== "string" || !text) return "";
  const cleaned = stripMarkdown(stripMachineBlocks(text))
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Cut on a word boundary when there is one close to the limit, so a preview
  // does not end mid-word more often than it has to.
  const cut = cleaned.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
