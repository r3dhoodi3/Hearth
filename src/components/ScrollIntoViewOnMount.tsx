"use client";

import { useEffect, useRef } from "react";

// Scrolls its children into view the moment they mount. For a confirmation
// banner that renders far down a long page (e.g. the "Job posted" banner on
// /contractors, which sits below the post-a-job form, My Pros, and the
// cold-start upsell), the reader is usually still scrolled to the form they
// just submitted and never sees the confirmation - the form itself resets
// (a fresh key after ?posted changes), so all they see is a blank form and
// no feedback that anything happened.
//
// "smooth" + "start": a jump would feel jarring right after a redirect, and
// "start" keeps the banner's own top edge (not its middle) at the top of the
// viewport, which is what a reader scanning down a page expects.
export default function ScrollIntoViewOnMount({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
