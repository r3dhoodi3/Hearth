"use client";

import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

// A mic button that dictates into the Ask Hearth box, using the browser's
// built-in Web Speech API (fast, free, on-device or through the browser's own
// speech service). It streams INTERIM words into a small live bubble above the
// button so the homeowner sees their words appear the moment they speak, and
// commits finalized segments via onText.
//
// There used to be a second mode here: getUserMedia + MediaRecorder, POSTing
// the audio to /api/transcribe for a server-side transcript. That route was a
// Gemini audio call, and it went away when Hearth moved to Claude, which has
// no audio transcription endpoint. So this is now speech-recognition only:
// where SpeechRecognition does not exist (Firefox), or where it fails, the
// button renders nothing and the homeowner types, rather than offering a mic
// that leads nowhere.
//
// Errors (mic blocked, no mic, recognition failed) surface as a short message
// in the bubble instead of being swallowed.

// Denied-state copy that says HOW to fix it, not just what happened. Shown
// longer than other flashes because it's instructions to follow.
const BLOCKED_MSG =
  "Microphone is blocked. Tap the icon by the address bar (or your browser's site settings), allow the mic, then try again.";
const BLOCKED_MSG_MS = 8000;

export default function VoiceButton({
  onText,
  disabled,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  // null while the mount effect is still deciding; false means this browser
  // has no SpeechRecognition and the button renders nothing.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  // The live bubble: interim speech, "Listening...", or a short error message.
  // Empty string hides it.
  const [bubble, setBubble] = useState("");

  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const recRef = useRef<any>(null);
  // True while the user means to keep dictating, so an automatic end event can
  // restart recognition instead of cutting them off mid sentence.
  const wantOnRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show a short error/status message in the bubble, then clear it.
  function flashBubble(msg: string, ms = 4000) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setBubble(msg);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setBubble("");
    }, ms);
  }

  useEffect(() => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      // Firefox and friends: no Web Speech at all, and no server fallback to
      // hand off to any more. Render nothing rather than a dead mic.
      setAvailable(false);
      return;
    }
    setAvailable(true);

    const rec = new SR();
    // Dictate in the browser's language (a Spanish speaker's browser is set to
    // es-*), falling back to English if it's unavailable.
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e: any) => {
      // Commit only the segments that just became final, starting at
      // resultIndex, so we never double count. Interim guesses go to the live
      // bubble so the homeowner sees words appear immediately while speaking.
      let finalText = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) finalText += t;
        else interim += t;
      }
      const done = finalText.trim();
      if (done) onTextRef.current(done);
      if (wantOnRef.current) setBubble(interim.trim() || "Listening...");
    };

    rec.onend = () => {
      // Chrome ends the session after a pause even in continuous mode. If the
      // user still wants to dictate, restart so their next words are captured.
      if (wantOnRef.current) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through to stop */
        }
      }
      setListening(false);
      if (!flashTimerRef.current) setBubble("");
    };

    rec.onerror = (e: any) => {
      const err = e?.error;
      // "aborted" is our own stop() or abort() coming back: wantOnRef is
      // already false, and onend does the cleanup.
      if (err === "aborted") return;
      // "no-speech" fires when the mic heard nothing at all. Returning early
      // here left wantOnRef true, so onend immediately restarted recognition,
      // which heard nothing again: a mic that stays lit and loops forever,
      // holding the microphone open on a phone until the tab is closed. Stop
      // and say so; tapping again is one gesture.
      if (err === "no-speech") {
        wantOnRef.current = false;
        setListening(false);
        flashBubble("Didn't catch that. Tap the mic and try again.");
        return;
      }
      wantOnRef.current = false;
      setListening(false);
      if (err === "not-allowed" || err === "service-not-allowed") {
        flashBubble(BLOCKED_MSG, BLOCKED_MSG_MS);
      } else if (err === "audio-capture") {
        flashBubble("No microphone found.");
      } else if (err === "network") {
        // Chrome's cloud speech service is unreachable (Brave, Electron,
        // blocked networks). There is no recorder fallback any more, so say so
        // plainly rather than looking broken.
        flashBubble("Voice input is unavailable in this browser.");
      } else {
        flashBubble("Voice input failed, try again.");
      }
    };

    recRef.current = rec;
    return () => {
      wantOnRef.current = false;
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The button goes disabled while a question is in flight, but disabling a
  // button does nothing to a recognition session that is already running: the
  // mic stayed live (and kept appending words to a composer the person could
  // no longer send from) for the whole request. Stop it when that happens.
  useEffect(() => {
    if (!disabled || !listening) return;
    wantOnRef.current = false;
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
    if (!flashTimerRef.current) setBubble("");
  }, [disabled, listening]);

  if (!available) return null;

  function toggle() {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) {
      wantOnRef.current = false;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      if (!flashTimerRef.current) setBubble("");
    } else {
      wantOnRef.current = true;
      try {
        rec.start();
        setListening(true);
        setBubble("Listening...");
      } catch {
        /* already started */
      }
    }
  }

  return (
    <span className="relative flex">
      {bubble ? (
        <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 w-max max-w-[min(220px,70vw)] rounded-lg border border-stone-200 bg-white px-2 py-1 text-left text-xs leading-snug text-stone-600 shadow-sm dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
          {bubble}
        </span>
      ) : null}
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        // title only shows on hover; aria-label covers touch + screen readers.
        aria-label={listening ? "Listening. Tap to stop." : "Speak your question"}
        aria-pressed={listening}
        title={listening ? "Listening. Tap to stop." : "Speak your question"}
        className={`flex items-center rounded-lg border px-2 text-lg disabled:opacity-50 ${
          listening
            ? "animate-pulse border-red-300 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            : "border-stone-200 text-stone-500 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-400 dark:hover:text-stone-300"
        }`}
      >
        <Mic className="h-5 w-5" aria-hidden="true" />
      </button>
    </span>
  );
}
