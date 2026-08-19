"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { initialMountCount, nextMountCount } from "./heroPhotoWindow";

// Landing hero photo cycler: a stack of licensed trade photos that crossfade
// one into the next, opacity only, no slide, no zoom, no dots, no arrows. The
// first photo is server-visible and loads with priority so the box paints
// straight away and never shifts; the rest fade in over the top as we cycle.
//
// Only a short prefix of the list is mounted at a time, growing as the cycle
// advances, so the photos request their bytes a couple of beats before they
// are needed instead of all at once on load. See heroPhotoWindow.ts.
//
// The cycle runs for EVERYONE and deliberately does NOT respect the OS
// reduced-motion flag. Founder direction, same rule as the demo camera in
// ProDemoPlayer.tsx: gating the crossfade off for anyone with Windows
// "Animation effects" disabled (including the founder) left the hero frozen on
// a single static photo, so the showcase never happened. The crossfade IS the
// hero, so it always plays. We still keep the photos.length <= 1 guard and
// pause the interval while the tab is hidden so we don't churn work off-screen.

type HeroPhoto = { src: string; alt: string };

const INTERVAL_MS = 3000;

export default function HeroPhotoCycler({ photos }: { photos: HeroPhoto[] }) {
  const [active, setActive] = useState(0);
  const [mountCount, setMountCount] = useState(() => initialMountCount(photos.length));

  // Widen the mount window as the cycle advances. Runs on the render after
  // `active` changes, which still leaves the newly mounted photo a full
  // LOOKAHEAD of beats (6s) to load before it is the one on screen.
  useEffect(() => {
    setMountCount((n) => nextMountCount(n, active, photos.length));
  }, [active, photos.length]);

  useEffect(() => {
    if (photos.length <= 1) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        setActive((i) => (i + 1) % photos.length);
      }, INTERVAL_MS);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    // Pause the loop while the tab is in the background, resume when it comes
    // back into view.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [photos.length]);

  return (
    // Reserve the hero's aspect ratio so the stacked, absolutely-positioned
    // photos have a box to fill and nothing shifts as they load.
    <div className="relative aspect-[3/2]">
      {photos.map((photo, i) => {
        // Not reached by the cycle yet: keep it out of the DOM so it does not
        // fire an image request the moment the hero paints.
        if (i >= mountCount) return null;
        const isActive = i === active;
        return (
          <Image
            key={photo.src}
            src={photo.src}
            alt={photo.alt}
            aria-hidden={isActive ? undefined : true}
            fill
            // Eager for the first two frames so the opening crossfade has its
            // target already decoded and never pops in late; the rest stay lazy.
            priority={i <= 1}
            loading={i <= 1 ? undefined : "lazy"}
            sizes="(min-width: 1024px) 40rem, 100vw"
            className={`object-cover transition-opacity duration-1000 ease-in-out ${
              isActive ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}
    </div>
  );
}
