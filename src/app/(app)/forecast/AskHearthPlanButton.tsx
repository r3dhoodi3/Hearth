import Link from "next/link";

// Hands the forecast's own numbers to Ask Hearth as a prefilled question.
//
// This used to dispatch a "hearth:ask-question" window event that the floating
// dock picked up. The dock is gone (Ask Hearth lives in Messages now), so this
// navigates instead: on a phone to the full-screen /ask, on sm and up to the
// Ask Hearth pane inside Messages. Two plain links behind a breakpoint rather
// than measuring the viewport in JS, so the href is right before hydration.
// Both destinations drop the ?q= from the address bar once the question has
// been asked, so a reload does not spend a second question on the same answer.
export default function AskHearthPlanButton({ question }: { question: string }) {
  const q = encodeURIComponent(question);

  return (
    <>
      <Link href={`/ask?q=${q}`} className="btn-secondary text-sm sm:hidden">
        Ask Hearth to help me plan
      </Link>
      <Link
        href={`/chats?lead=ask-hearth&q=${q}`}
        className="btn-secondary hidden text-sm sm:inline-flex"
      >
        Ask Hearth to help me plan
      </Link>
    </>
  );
}
