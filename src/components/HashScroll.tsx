"use client";

import { useEffect } from "react";

// Renders nothing. Scrolls to the element named by the URL hash once it
// exists, so a deep link like /pro/business#insurance lands on the section
// instead of at the top of the page.
//
// C6: the "Add insurance" buttons link to /pro/business#insurance, and the
// section renders, but native fragment scrolling only fires when the target
// is in the DOM at the moment the browser applies the hash. On this page the
// target is inside a server-rendered card that hydrates after the initial
// paint and the App Router's own scroll restoration then wins, so the jump
// worked 2 to 4 times out of 5 in testing. This retries briefly until the
// element appears, then scrolls it into view once. It never scrolls when
// there is no hash, so every other visit to the page is unaffected.
export default function HashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id) return;
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
      tries += 1;
      if (tries < 20) timer = window.setTimeout(attempt, 100);
    };
    attempt();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return null;
}
