"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import Logo from "./Logo";
import styles from "./HeroDemoPlayer.module.css";
import { track } from "@/lib/analytics";

// Inline click-to-play landing demo, rebuilt from an 11-agent research pass
// on high-converting product videos and web-audio sound design. The shape:
//
// - 30 seconds, 80 beats at 160 BPM (375ms per beat), half-time phonk-style
//   drums; every cut lands on the beat grid.
// - FULL app pages (nav bar and all) inside a browser device, with a virtual
//   camera that punches into click targets (Screen Studio style), so a
//   normal-sized cursor still owns the frame.
// - One continuous session: hook with a flash-forward in the first 2s, then
//   address -> dashboard -> post a job -> pro side -> job won (the drop, at
//   ~79% of runtime) -> end card that resolves the score open loop.
// - Kinetic captions carry the story for muted viewers; a mid-video CTA chip
//   appears at the ~20s engagement peak; a step chip signals progress.
// - Audio is fully synthesized: sidechain-pumped music bus through soft
//   saturation, a glue compressor and a limiter stand-in; thocky keyboard,
//   soft apple-style clicks, whooshes, a 3-layer riser that hard-cuts to
//   silence 30ms before the payoff hit.

const BEAT_MS = 375; // 160 BPM
const BEAT_S = BEAT_MS / 1000;
const TOTAL_BEATS = 80;
const TOTAL_MS = TOTAL_BEATS * BEAT_MS;

// Homeowner-only story (the pro side gets its own video later): someone
// types the Hearth URL, sees the dashboard, adds their address, posts a job,
// a notification pops, and the pro's quote gets accepted in Messages.
// 78 beats = 29.25 seconds; the BOOKED payoff lands on beat 63 (~81%).
type SceneDef = { id: string; beats: number; step: string | null };
const SCENES: SceneDef[] = [
  { id: "hook", beats: 13, step: null },
  { id: "address", beats: 9, step: "1/5" },
  { id: "dash", beats: 16, step: "2/5" },
  { id: "postjob", beats: 14, step: "3/5" },
  { id: "chat", beats: 20, step: "4/5" },
  { id: "end", beats: 8, step: "5/5" },
];

// Which page each scene shows (scenes can share a page for continuity).
const SCENE_PAGE: Record<string, string> = {
  hook: "dashPage",
  address: "onboardPage",
  dash: "dashPage",
  postjob: "postjobPage",
  chat: "chatPage",
  end: "endPage",
};

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m < 10 ? "0" + m : m}:${r < 10 ? "0" + r : r}`;
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function HouseMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11.5 12 4l4 3.33V5.5h2.5v3.92L21 11.5" />
      <path d="M5 10.5V20h14v-9.5" />
      <path
        d="M12 17.8c1.8 0 3-1.2 3-2.8 0-1.9-1.7-2.6-2.2-4-.9.6-1 1.5-.9 2.2-.6-.2-1-.6-1.2-1.2-.9.8-1.7 1.9-1.7 3 0 1.6 1.2 2.8 3 2.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

// The demo pages copy the LIVE site as it renders (see the founder's
// dashboard/Messages screenshots): logo + wordmark, the address switcher,
// the four tabs with the Messages unread badge, Tools, search, bell, and
// the avatar + name. Rendered at natural size, then the page scales to fit
// the device, so every pixel matches the production stylesheet.
function AppNav({
  active = 0,
  msgTabX = false,
  msgBadge = false,
  logoX = false,
}: {
  active?: number;
  // Marks THIS nav's Messages tab as the cursor's click target (only one
  // page's nav may carry it, since anchors are queried document-wide).
  msgTabX?: boolean;
  msgBadge?: boolean;
  // Marks THIS nav's logo as the hook transition's zoom-out origin.
  logoX?: boolean;
}) {
  const tabs = ["Home", "Issues", "Post a Job", "Messages"];
  return (
    // Tight spacing so the whole strip, name included, always fits the
    // frame: nothing on the right edge may clip.
    <header className="flex items-center gap-2 border-b border-stone-200/70 bg-white/80 px-4 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-lg font-semibold text-stone-900" {...(logoX ? { "data-x": "navLogo" } : {})}>
        <Logo className="h-6 w-6 text-hearth-700" /> Hearth
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm text-stone-600">
        123 Maple St <span className="text-[10px] text-stone-400">▾</span>
      </span>
      <span className="flex items-center">
        {tabs.map((t, i) => (
          <span
            key={t}
            {...(msgTabX && t === "Messages" ? { "data-x": "msgTab" } : {})}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium ${
              i === active ? "bg-hearth-100 text-hearth-800" : "text-stone-600"
            }`}
          >
            {t}
            {t === "Messages" && msgBadge && (
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
                1
              </span>
            )}
          </span>
        ))}
        <span className="flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium text-stone-600">
          Tools <span className="text-[10px] text-stone-400">▾</span>
        </span>
      </span>
      <span className="flex min-w-[56px] flex-1 items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-400">
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <span className="hidden min-[500px]:inline">Search</span>
      </span>
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-stone-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-stone-700">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-hearth-100 text-sm font-semibold text-hearth-700">J</span>
        John Doe <span className="text-[10px] text-stone-400">▾</span>
      </span>
    </header>
  );
}

type EngineApi = {
  play: () => void;
  toggleMute: () => boolean;
  // null means "there was nothing to pause" (e.g. the finishTour end
  // window): the caller should treat it as a request to restart.
  togglePause: () => boolean | null;
  setVolume: (v: number) => void;
  setRate: (r: number) => void;
  seek: (frac: number) => void;
  scrubStart: () => void;
};

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

function fullscreenTarget(): Element | null {
  const d = document as FsDocument;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

const RATES = [1, 1.5, 2, 0.75];

export default function HeroDemoPlayer() {
  const shellRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EngineApi | null>(null);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [rateIdx, setRateIdx] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const root = boxRef.current;
    if (!root) return;
    // Narrowed alias: TS won't carry the null-check above into function
    // DECLARATIONS defined later in this scope (only into closures created
    // at this point, like q/qa below), so togglePause/play use this instead
    // of `root` directly.
    const boxEl: HTMLDivElement = root;

    // OS reduced-motion tones down the big camera zooms, shake, and flash
    // (the vestibular triggers) but NEVER removes the cursor, typing, or
    // click sounds: those are the demo's content, and hiding them
    // (as an earlier version did) made the video look broken on machines
    // with Windows "Animation effects" turned off.
    const fxReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);
    const qa = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel));

    // ======================= AUDIO ENGINE =======================
    let ctx: AudioContext | null = null;
    let outGain: GainNode | null = null; // master volume / mute
    let limiter: DynamicsCompressorNode | null = null;
    let glue: DynamicsCompressorNode | null = null;
    let musicBus: GainNode | null = null; // sidechain + SFX duck target
    let sfxBus: GainNode | null = null;
    let kickBus: GainNode | null = null; // bypasses the duck
    let ppIn: GainNode | null = null; // ping-pong delay send
    // Per-run bus for LONG one-shots (riser, win arp, ring-outs) so a seek
    // can kill their tails instead of letting them bleed over the restarted
    // track. Recreated by startMusic, faded and dropped by stopMusic.
    let runVoices: GainNode | null = null;
    let noiseBuffer: AudioBuffer | null = null;
    let isMuted = false;
    // True while a seek fast-forwards the timeline: choreography runs
    // instantly and every foreground SFX/one-shot visual stays silent so a
    // scrub does not machine-gun thirty click sounds.
    let seeking = false;
    // True from the first drag event on the seek bar until the release
    // commits: silences output and freezes the progress UI writes.
    let scrubbing = false;
    let userVolume = 1; // 0..1 factor from the volume slider
    const MASTER_VOL = 0.8;

    // Single source of truth for the output level: mute and scrubbing zero
    // it, otherwise the slider scales it. Every mute/volume/scrub/seek path
    // funnels through here so no path can leave the player silent.
    function outGainTarget() {
      return isMuted || scrubbing ? 0 : MASTER_VOL * userVolume;
    }
    function applyOutGain() {
      // A raw `.value =` assignment does NOT cancel an already-scheduled
      // linearRampToValueAtTime (e.g. togglePause's pause/resume fade): the
      // pending ramp would still fire later and silently override this
      // target. Always cancel + pin at the current instant first, so every
      // mute/volume/scrub/seek path is guaranteed to land on the real
      // target, never a stale ramp.
      if (!ctx || !outGain) return;
      const t = ctx.currentTime;
      outGain.gain.cancelScheduledValues(t);
      outGain.gain.setValueAtTime(outGainTarget(), t);
    }
    // ~-12dB music bed: loud enough to drive, quiet enough that the VO and
    // the click/keyboard SFX (which stay at full level) always sit on top.
    const MUSIC_BASE = 0.25;

    function ensureAudio() {
      if (ctx) return;
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      ctx = new AC();

      outGain = ctx.createGain();
      outGain.connect(ctx.destination);
      applyOutGain();

      // Limiter stand-in: hard knee, high ratio, 1ms attack.
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      limiter.connect(outGain);

      // Glue compressor ahead of the limiter.
      glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -12;
      glue.knee.value = 6;
      glue.ratio.value = 4;
      glue.attack.value = 0.003;
      glue.release.value = 0.25;
      glue.connect(limiter);

      // Music bus -> soft saturation -> glue. Kick bypasses the duck so the
      // pump reads against a steady kick.
      const shaper = ctx.createWaveShaper();
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = Math.tanh(2.5 * x);
      }
      shaper.curve = curve;
      shaper.oversample = "4x";
      shaper.connect(glue);

      musicBus = ctx.createGain();
      musicBus.gain.value = MUSIC_BASE;
      musicBus.connect(shaper);

      kickBus = ctx.createGain();
      // Kick rides with the music bed level (it bypasses the duck, not the
      // mix decision).
      kickBus.gain.value = 0.32;
      kickBus.connect(glue);

      sfxBus = ctx.createGain();
      // Hot: clicks and keys are the ASMR content, the limiter catches peaks.
      sfxBus.gain.value = 1.45;
      sfxBus.connect(glue);

      // Tempo-synced ping-pong delay as cheap space for leads/wins.
      ppIn = ctx.createGain();
      ppIn.gain.value = 0.25;
      const dl = ctx.createDelay(1);
      const dr = ctx.createDelay(1);
      dl.delayTime.value = 0.281; // dotted 8th at 160 BPM
      dr.delayTime.value = 0.281;
      const fb = ctx.createGain();
      fb.gain.value = 0.35;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 400;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 4000;
      const panL = ctx.createStereoPanner();
      panL.pan.value = -0.6;
      const panR = ctx.createStereoPanner();
      panR.pan.value = 0.6;
      ppIn.connect(dl);
      dl.connect(panL);
      panL.connect(musicBus);
      dl.connect(hp);
      hp.connect(lp);
      lp.connect(fb);
      fb.connect(dr);
      dr.connect(panR);
      panR.connect(musicBus);
      dr.connect(dl);
    }

    function getNoise(): AudioBuffer | null {
      if (!ctx) return null;
      if (!noiseBuffer) {
        const len = Math.floor(ctx.sampleRate * 1.0);
        noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      return noiseBuffer;
    }

    // Sidechain pump: dive the music bus on each kick, exponential recovery.
    function pump(t: number, depth = 0.25, release = 0.32) {
      if (!musicBus) return;
      const g = musicBus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(MUSIC_BASE, t);
      g.linearRampToValueAtTime(MUSIC_BASE * depth, t + 0.015);
      g.exponentialRampToValueAtTime(MUSIC_BASE, t + release);
    }

    // Duck music under a foreground SFX (gentler than the kick pump).
    function duckForSfx(lenS = 0.15) {
      if (!ctx || !musicBus) return;
      const t = ctx.currentTime;
      const g = musicBus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(MUSIC_BASE * 0.63, t + 0.02);
      g.exponentialRampToValueAtTime(MUSIC_BASE, t + lenS + 0.3);
    }

    function kick(t: number) {
      if (!ctx || !kickBus) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.04);
      g.gain.setValueAtTime(1.0, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g);
      g.connect(kickBus);
      o.start(t);
      o.stop(t + 0.25);
      const buf = getNoise();
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = 4000;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.25, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
        src.connect(f);
        f.connect(ng);
        ng.connect(kickBus);
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.05);
      }
      pump(t);
    }

    function snare(t: number, vol = 0.5) {
      if (!ctx || !musicBus) return;
      const buf = getNoise();
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1900;
      f.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
      src.connect(f);
      f.connect(g);
      g.connect(musicBus);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.13);
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = 190;
      og.gain.setValueAtTime(vol * 0.4, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.connect(og);
      og.connect(musicBus);
      o.start(t);
      o.stop(t + 0.09);
    }

    function hatN(t: number, vol = 0.28) {
      if (!ctx || !musicBus) return;
      const buf = getNoise();
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = 8000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      src.connect(f);
      f.connect(g);
      g.connect(musicBus);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.05);
    }

    // Detuned 3-saw bass stack through a moving lowpass (kills the buzz).
    function bassNote(t: number, freq: number, dur = 0.18) {
      if (!ctx || !musicBus) return;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.Q.value = 8;
      f.frequency.setValueAtTime(2200, t);
      f.frequency.exponentialRampToValueAtTime(300, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.63 / 3, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      f.connect(g);
      g.connect(musicBus);
      [-12, 0, 12].forEach((cents, i) => {
        const o = ctx!.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = i === 2 ? freq * 2 : freq;
        o.detune.value = cents;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.03);
      });
    }

    // Em add9 pluck stab: paired detuned triangles per note.
    const CHORD = [164.81, 196.0, 246.94, 370.0];
    function pluck(t: number, vol = 0.35, filtered = false) {
      if (!ctx || !musicBus) return;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filtered ? 800 : 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol / CHORD.length, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      f.connect(g);
      g.connect(musicBus);
      if (ppIn) g.connect(ppIn);
      CHORD.forEach((freq) => {
        [-6, 6].forEach((cents) => {
          const o = ctx!.createOscillator();
          o.type = "triangle";
          o.frequency.value = freq;
          o.detune.value = cents;
          o.connect(f);
          o.start(t);
          o.stop(t + 0.3);
        });
      });
    }

    // Phonk cowbell: square pair through a bandpass, offbeat signature.
    function cowbell(t: number) {
      if (!ctx || !musicBus) return;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1200;
      f.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      f.connect(g);
      g.connect(musicBus);
      if (ppIn) g.connect(ppIn);
      [540, 800].forEach((freq) => {
        const o = ctx!.createOscillator();
        o.type = "square";
        o.frequency.value = freq;
        o.connect(f);
        o.start(t);
        o.stop(t + 0.14);
      });
    }

    // Big impact: noise burst + 55Hz sine tail.
    function impactHit(t: number, tail = 1.2) {
      if (!ctx || !sfxBus) return;
      const buf = getNoise();
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = 3000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        src.connect(f);
        f.connect(g);
        g.connect(runVoices ?? sfxBus);
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.3);
      }
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 55;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.45, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + tail);
      o.connect(g);
      g.connect(runVoices ?? sfxBus);
      o.start(t);
      o.stop(t + tail + 0.05);
    }

    // ---- Arrangement over the 80-beat grid ----
    const BASS_BAR = [41.2, 41.2, 49.0, 55.0]; // E1 E1 G1 A1
    const DROP = 22;
    const RISER_START = 60;
    const WIN = 65;
    const FINAL = 72;

    function grooveOn(n: number): boolean {
      return n >= DROP && n < FINAL;
    }

    // bs = seconds per beat at the current playback rate; sub-beat offsets
    // use it so time scales while pitch stays untouched.
    function scheduleBeat(n: number, t: number, bs: number) {
      // Hats: eighths in the intro/groove, sixteenths through riser+victory.
      if (n < FINAL) {
        const inRush = n >= RISER_START && n < FINAL;
        const divs = inRush ? 4 : 2;
        const vol = n < DROP ? 0.16 : inRush ? 0.2 : 0.26;
        for (let i = 0; i < divs; i++) hatN(t + (i * bs) / divs, vol);
      }

      // Intro plucks, filtered dark before the drop opens them up.
      if (n < DROP - 2 && n % 4 === 0) pluck(t, 0.3, true);

      // Snare roll into the drop: 16ths then 32nds, then a hard 1-beat
      // silence (minus roll) right before the drop.
      if (n === DROP - 2) for (let i = 0; i < 4; i++) snare(t + (i * bs) / 4, 0.3);
      if (n === DROP - 1) for (let i = 0; i < 4; i++) snare(t + (i * bs) / 8, 0.35);

      if (grooveOn(n)) {
        // Half-time: kick on the 1, snare on the 3.
        if (n % 4 === 0) kick(t);
        if (n % 4 === 2) snare(t);
        // Bass: root eighths, moving-filter saw stack.
        const f = BASS_BAR[n % 4];
        if (!(n >= RISER_START && n < WIN)) {
          bassNote(t, f);
          bassNote(t + bs / 2, f, 0.11);
        }
        // Cowbell offbeats for the phonk signature, rests during the riser.
        if (n % 2 === 1 && n < RISER_START) cowbell(t + bs / 2);
        // Chord stab on bar starts.
        if (n % 8 === 0) pluck(t, 0.35);
      }

      // Riser: three layers, hard-cut 30ms before the win hit.
      if (n === RISER_START) {
        riser(t + 0.075, (WIN - RISER_START) * bs - 0.075 - 0.03);
      }

      // THE WIN: impact + coin arpeggio; visuals sync in enterChat.
      if (n === WIN) {
        impactHit(t);
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          const t0 = t + 0.06 + i * 0.09;
          coinNote(t0, f, i === 3);
        });
      }

      // Final: one big hit and a long Em add9 ring, everything else stops.
      if (n === FINAL) {
        impactHit(t, 1.4);
        pluckRing(t + 0.1);
      }
    }

    function coinNote(t: number, freq: number, last: boolean) {
      if (!ctx || !sfxBus) return;
      const o = ctx.createOscillator();
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = freq;
      f.type = "lowpass";
      f.frequency.value = 6000;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(f);
      f.connect(g);
      g.connect(runVoices ?? sfxBus);
      if (ppIn) g.connect(ppIn);
      o.start(t);
      o.stop(t + 0.45);
      if (last) {
        const sub = ctx.createOscillator();
        const sg = ctx.createGain();
        sub.type = "triangle";
        sub.frequency.value = 130;
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.2, t + 0.008);
        sg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        sub.connect(sg);
        sg.connect(runVoices ?? sfxBus);
        sub.start(t);
        sub.stop(t + 0.18);
      }
    }

    function pluckRing(t: number) {
      if (!ctx || !musicBus) return;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.3 / 4, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      g.connect(runVoices ?? musicBus);
      if (ppIn) g.connect(ppIn);
      [164.81, 196.0, 246.94, 329.63].forEach((freq) => {
        [-5, 5].forEach((cents) => {
          const o = ctx!.createOscillator();
          o.type = "triangle";
          o.frequency.value = freq;
          o.detune.value = cents;
          o.connect(g);
          o.start(t);
          o.stop(t + 1.9);
        });
      });
    }

    function riser(t: number, durS: number) {
      if (!ctx || !sfxBus) return;
      // Layer 1: gliding saw.
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(440, t + durS);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.12, t + durS);
      og.gain.setValueAtTime(0.0001, t + durS + 0.001);
      o.connect(og);
      og.connect(runVoices ?? sfxBus);
      o.start(t);
      o.stop(t + durS + 0.01);
      // Layer 2: sweeping noise.
      const buf = getNoise();
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.setValueAtTime(200, t);
        f.frequency.exponentialRampToValueAtTime(6000, t + durS);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.18, t + durS);
        g.gain.setValueAtTime(0.0001, t + durS + 0.001);
        src.connect(f);
        f.connect(g);
        g.connect(runVoices ?? sfxBus);
        src.start(t);
        src.stop(t + durS + 0.01);
      }
      // Layer 3: accelerating tremolo stutter.
      const o3 = ctx.createOscillator();
      const g3 = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      o3.type = "square";
      o3.frequency.value = 220;
      lfo.type = "square";
      lfo.frequency.setValueAtTime(8, t);
      lfo.frequency.exponentialRampToValueAtTime(30, t + durS);
      lg.gain.value = 0.04;
      lfo.connect(lg);
      lg.connect(g3.gain);
      g3.gain.setValueAtTime(0.04, t);
      g3.gain.setValueAtTime(0.0001, t + durS + 0.001);
      o3.connect(g3);
      g3.connect(sfxBus);
      o3.start(t);
      o3.stop(t + durS + 0.01);
      lfo.start(t);
      lfo.stop(t + durS + 0.01);
    }

    // ---- Foreground SFX ----
    // Thocky keypress: 110-150Hz triangle body + 2500Hz noise tick.
    function thock() {
      // Clicky gaming keyboard (blue-switch style): a bright resonant tick
      // around 2kHz (the click jacket), a sharp treble snap, and only a
      // small plastic body underneath. Deliberately trebly, not thocky.
      ensureAudio();
      if (!ctx || !sfxBus || seeking) return;
      const t = ctx.currentTime;
      const vol = 0.5 * (0.9 + Math.random() * 0.2);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 1900 + Math.random() * 500;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol * 0.3, t + 0.0006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      o.connect(g);
      g.connect(sfxBus);
      o.start(t);
      o.stop(t + 0.03);
      const body = ctx.createOscillator();
      const bg = ctx.createGain();
      body.type = "triangle";
      body.frequency.value = 200 + Math.random() * 60;
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.linearRampToValueAtTime(vol * 0.5, t + 0.001);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      body.connect(bg);
      bg.connect(sfxBus);
      body.start(t);
      body.stop(t + 0.05);
      const buf = getNoise();
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = 4800 + Math.random() * 800;
        f.Q.value = 1.2;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(vol * 0.5, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.008);
        src.connect(f);
        f.connect(ng);
        ng.connect(sfxBus);
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.02);
      }
      duckForSfx(0.05);
    }

    // Soft apple-style mouse click: noise snap + down-chirped sine.
    function clickSound() {
      ensureAudio();
      if (!ctx || !sfxBus || seeking) return;
      const t = ctx.currentTime;
      const buf = getNoise();
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 1800;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 6000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.85, t + 0.0005);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
        src.connect(hp);
        hp.connect(lp);
        lp.connect(g);
        g.connect(sfxBus);
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.03);
      }
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(1000, t);
      o.frequency.exponentialRampToValueAtTime(600, t + 0.015);
      og.gain.setValueAtTime(0.45, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      o.connect(og);
      og.connect(sfxBus);
      o.start(t);
      o.stop(t + 0.04);
      duckForSfx(0.05);
    }

    // Whoosh per page transition, pitched up entering / down for pivots.
    function whoosh(up = true) {
      ensureAudio();
      if (!ctx || !sfxBus || seeking) return;
      const t = ctx.currentTime;
      const buf = getNoise();
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = 1;
      if (up) {
        f.frequency.setValueAtTime(400, t);
        f.frequency.exponentialRampToValueAtTime(4000, t + 0.18);
        f.frequency.exponentialRampToValueAtTime(800, t + 0.3);
      } else {
        f.frequency.setValueAtTime(3000, t);
        f.frequency.exponentialRampToValueAtTime(300, t + 0.25);
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.4, t);
      pan.pan.linearRampToValueAtTime(0.4, t + 0.3);
      src.connect(f);
      f.connect(g);
      g.connect(pan);
      pan.connect(sfxBus);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.35);
      duckForSfx(0.2);
    }

    // Clean single "ding" for micro-wins: a bell fundamental with one soft
    // upper partial, fast attack, natural decay. Replaced the two-note
    // arcade coin per the founder's direction.
    function coin() {
      ensureAudio();
      if (!ctx || !sfxBus || seeking) return;
      const t = ctx.currentTime;
      const partials: Array<[number, number]> = [
        [1318.5, 0.16],
        [2637.0, 0.05],
      ];
      partials.forEach(([freq, vol]) => {
        const o = ctx!.createOscillator();
        const g = ctx!.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
        o.connect(g);
        g.connect(sfxBus!);
        if (ppIn) g.connect(ppIn);
        o.start(t);
        o.stop(t + 0.75);
      });
      duckForSfx(0.1);
    }

    // ---- Voiceover (Web Speech API, no audio files) ----
    // Short conversational lines carry the story; captions supplement for
    // muted viewers. One line at a time; mute/pause/seek all respect it.
    let voVoice: SpeechSynthesisVoice | null = null;
    function pickVoice() {
      if (voVoice || typeof speechSynthesis === "undefined") return;
      const vs = speechSynthesis.getVoices();
      voVoice =
        vs.find((v) => /en[-_]US/i.test(v.lang) && /natural|neural|aria|jenny|online/i.test(v.name)) ??
        vs.find((v) => /en[-_]US/i.test(v.lang)) ??
        null;
    }
    function speak(text: string) {
      // Bail while paused too: a stalled audio-element play() promise
      // resolving during a pause must never wake the ghost speechSynthesis
      // voice over a frozen frame.
      if (seeking || isMuted || paused || typeof speechSynthesis === "undefined") return;
      pickVoice();
      const u = new SpeechSynthesisUtterance(text);
      if (voVoice) u.voice = voVoice;
      u.rate = 1.05 * rate;
      u.pitch = 1;
      u.volume = Math.min(1, 0.95 * userVolume);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
    function stopSpeech() {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    }

    // Primary narration: pre-generated neural-TTS MP3s in /public/demo-vo
    // (a real human-sounding voice). speechSynthesis above is only the
    // fallback if a file fails to load or play.
    const VO_TEXT = {
      hook: "This is Hearth. Your home, looked after.",
      address: "Just type your address to get started.",
      dash: "Hearth gives your home a health score, and catches problems before they cost you.",
      postjob: "Something break? Post a job in seconds, with the price up front.",
      chat: "A real quote from a local pro, straight to your messages.",
      booked: "Booked. That easy.",
      end: "Hearth. Free for homeowners.",
    } as const;
    type VoKey = keyof typeof VO_TEXT;
    const voAudios: Partial<Record<VoKey, HTMLAudioElement>> = {};
    let currentVo: HTMLAudioElement | null = null;

    function initVoAudio() {
      if (typeof Audio === "undefined" || Object.keys(voAudios).length > 0) return;
      (Object.keys(VO_TEXT) as VoKey[]).forEach((k) => {
        const a = new Audio(`/demo-vo/${k}.mp3`);
        a.preload = "auto";
        voAudios[k] = a;
      });
    }

    // Tracks the most recent narration line and WHEN it started (virtual
    // clock), so a seek can resume the voice mid-sentence at the right word.
    let lastVoKey: VoKey | null = null;
    let lastVoStartV = 0;

    function playVo(key: VoKey) {
      lastVoKey = key;
      lastVoStartV = vnow;
      if (seeking) return;
      // Mute suppresses AUDIO only: the captions are the muted viewer's
      // narration, so they always render (every test viewer flagged this).
      captionVo(key);
      if (isMuted) return;
      if (currentVo) {
        currentVo.pause();
        currentVo = null;
      }
      stopSpeech();
      const a = voAudios[key];
      if (!a) {
        speak(VO_TEXT[key]);
        return;
      }
      a.currentTime = 0;
      a.volume = Math.min(1, userVolume);
      a.playbackRate = rate;
      // If play() rejects because a pause landed mid-startup, don't fall
      // back to speechSynthesis over a now-frozen frame. Also bail if a
      // seek/scrub is what interrupted it (stopVo()'s pause() can reject an
      // in-flight play() promise with AbortError): firing the robotic
      // fallback over a scrub is its own flavor of the same glitch.
      a.play().catch(() => {
        if (!paused && !seeking && !scrubbing) speak(VO_TEXT[key]);
      });
      currentVo = a;
    }

    function stopVo() {
      if (currentVo) {
        currentVo.pause();
        currentVo = null;
      }
      stopSpeech();
    }

    // Music lookahead scheduler: events placed at exact context times.
    // offsetContentMs lets a seek restart the track mid-song: beat N of the
    // grid stays beat N of the picture no matter where playback resumes.
    let musicTimer: ReturnType<typeof setTimeout> | null = null;
    function startMusic(offsetContentMs = 0) {
      ensureAudio();
      if (!ctx || !glue) return;
      // Fresh per-run bus for the long one-shots so a later seek can kill
      // their tails instantly.
      runVoices = ctx.createGain();
      // The big one-shots (win impact, arp, ring-out) are MUSIC: they sit at
      // the same ~-12dB bed level as everything musical, per the founder's
      // standing rule, so the ending can never blast.
      runVoices.gain.value = 0.28;
      runVoices.connect(glue);
      const beatS = BEAT_S / rate; // rate scales time only, never pitch
      const startAt = ctx.currentTime + 0.06 - offsetContentMs / 1000 / rate;
      let next = Math.max(0, Math.ceil(offsetContentMs / BEAT_MS - 1e-6));
      const tickMusic = () => {
        if (!ctx) return;
        while (next < TOTAL_BEATS && startAt + next * beatS < ctx.currentTime + 0.14) {
          const t = startAt + next * beatS;
          if (t >= ctx.currentTime - 0.01) scheduleBeat(next, t, beatS);
          next++;
        }
        if (next < TOTAL_BEATS) musicTimer = setTimeout(tickMusic, 25);
      };
      tickMusic();
    }
    function stopMusic() {
      if (musicTimer) clearTimeout(musicTimer);
      // Kill any still-sounding long tails (riser sweep, win arp, ring-out)
      // with a 20ms fade so they can't bleed over a restarted track.
      if (runVoices && ctx) {
        const rv = runVoices;
        const t = ctx.currentTime;
        rv.gain.cancelScheduledValues(t);
        rv.gain.setValueAtTime(rv.gain.value, t);
        rv.gain.linearRampToValueAtTime(0.0001, t + 0.02);
        setTimeout(() => {
          try {
            rv.disconnect();
          } catch {
            /* already disconnected */
          }
        }, 60);
        runVoices = null;
      }
    }

    function setMutedInternal(m: boolean) {
      isMuted = m;
      applyOutGain();
      if (m) stopVo();
    }

    function setVolumeInternal(v: number) {
      userVolume = Math.min(1, Math.max(0, v));
      applyOutGain();
      if (currentVo) currentVo.volume = Math.min(1, userVolume);
    }

    // ======================= TIMERS =======================
    // Playback rate: scales every delay routed through `after` (scenes,
    // atBeat, captions, cursor choreography) plus the music beat grid.
    let rate = 1;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Virtual clock so the whole timeline can PAUSE like a real player: the
    // progress rAF advances `vnow` only while unpaused and fires due events.
    // Pausing also suspends the AudioContext, freezing every scheduled note
    // at the same instant, so resume picks up mid-beat in sync.
    let vnow = 0;
    let lastTickTs: number | null = null;
    let paused = false;
    // Bumped on every togglePause call; every deferred callback (the
    // suspend timeout, the resume promise) checks its own captured gen
    // against the live value before touching state, so rapid pause/resume
    // hammering can never let a stale callback fire out of order.
    let pauseGen = 0;
    // True from the moment resume() is requested until the context is
    // actually confirmed running: holds the virtual clock so vnow can't
    // race ahead of audio that hasn't restarted yet.
    let clockHold = false;
    type QueuedEvent = { t: number; fn: () => void };
    let events: QueuedEvent[] = [];
    const after = (ms: number, fn: () => void) => {
      events.push({ t: vnow + ms / rate, fn });
    };
    const atBeat = (b: number, fn: () => void) => after(b * BEAT_MS, fn);
    // Always fire in CHRONOLOGICAL order (earliest first), never array
    // order: nested chains depend on it.
    function fireDueEvents(upTo = vnow) {
      for (;;) {
        let best = -1;
        for (let i = 0; i < events.length; i++) {
          if (events[i].t <= upTo && (best < 0 || events[i].t < events[best].t)) best = i;
        }
        if (best < 0) break;
        const [e] = events.splice(best, 1);
        // Advance the virtual clock TO the event before firing it, so any
        // events it registers (clickOn's nested afters, typing chains) are
        // based at the right instant. Critical for seek fast-forwards.
        vnow = Math.max(vnow, e.t);
        e.fn();
      }
      vnow = Math.max(vnow, Math.min(upTo, effTotalMs));
    }

    // ======================= CAMERA =======================
    let currentScale = 1;
    let activePage: HTMLElement | null = null;

    function screenSize() {
      const s = q("[data-x='screen']");
      return s ? { w: s.clientWidth, h: s.clientHeight } : { w: 480, h: 260 };
    }

    function layoutRect(el: HTMLElement) {
      // Rect in untransformed page coordinates: measured rect divided by the
      // camera's current scale, relative to the page origin.
      if (!activePage) return { x: 0, y: 0, w: 0, h: 0 };
      const p = activePage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        x: (r.left - p.left) / currentScale,
        y: (r.top - p.top) / currentScale,
        w: r.width / currentScale,
        h: r.height / currentScale,
      };
    }

    // The camera is a per-frame rig, not CSS transitions: it lerps its zoom
    // level and, while zoomed in, continuously tracks the CURSOR, so the
    // frame pans with the mouse exactly like a Screen Studio follow-cam.
    // Page cuts get a quick pop-zoom by bumping the live scale above its
    // target and letting the lerp settle.
    // follow modes: "cursor" tracks the mouse (used during clicks so the
    // frame travels with the hand), "point" holds a fixed subject (used for
    // narration zooms so the shot does not drift back to an idle cursor),
    // "wide" recenters at scale 1.
    // NOTE: the camera deliberately does NOT respect the OS reduced-motion
    // flag. It gated all zooms off for anyone with Windows "Animation
    // effects" disabled (including the founder), making the demo look
    // zoomless. The zooms ARE the video; only shake/flash stay behind
    // fxReduced.
    const cam = { s: 1, sT: 1, cx: 240, cy: 130, px: 240, py: 130, follow: "wide" as "cursor" | "point" | "wide" };

    function focusOn(sel: string, scale = 1.7, _ms = 520) {
      const el = q(sel);
      if (!el) return;
      const r = layoutRect(el);
      cam.px = r.x + r.w / 2;
      cam.py = r.y + r.h / 2;
      cam.sT = scale;
      cam.follow = "point";
    }

    function followCursorZoom(scale = 1.7) {
      cam.sT = scale;
      cam.follow = "cursor";
    }

    function cameraWide(_ms = 520) {
      cam.sT = 1;
      cam.follow = "wide";
    }

    function cameraSnapWide() {
      cam.s = 1;
      cam.sT = 1;
      cam.follow = "wide";
      currentScale = 1;
      const el = q("[data-x='camera']");
      if (el) el.style.transform = "translate(0px, 0px) scale(1)";
    }

    // Snap the camera hard onto a target (no lerp-in), used for the logo
    // fill-then-zoom-out transition after the URL wipe.
    function cameraSnapTo(sel: string, scale: number) {
      const el = q(sel);
      if (!el) return;
      const r = layoutRect(el);
      cam.px = r.x + r.w / 2;
      cam.py = r.y + r.h / 2;
      cam.cx = cam.px;
      cam.cy = cam.py;
      cam.s = scale;
      cam.sT = scale;
      cam.follow = "point";
    }

    // Pop-zoom on a cut: a SUBTLE overshoot the lerp settles back; big
    // jolts read as jarring, not energetic.
    function punchCamera() {
      cam.s = Math.max(cam.s, cam.sT + 0.06);
    }

    // ======================= CURSOR =======================
    // Spring physics (velocity + damping) instead of a raw lerp: the hand
    // eases in AND out and rounds its corners, so direction changes never
    // look robotically sharp.
    const cur = { x: 240, y: 140, tx: 240, ty: 140, vx: 0, vy: 0 };
    let cursorRaf: number | null = null;
    // When a voiceover line is sounding, captions are driven off its REAL
    // playback position (in cursorLoop) so they can never drift from the
    // spoken words. Null when muted / no audio (then captionVo schedules an
    // estimated fallback instead).
    let capState: {
      a: HTMLAudioElement;
      chunks: string[][];
      durMs: number;
      lastIdx: number;
    } | null = null;

    function cursorLoop() {
      // Freeze all motion while paused (a paused video must not drift).
      if (paused) {
        cursorRaf = requestAnimationFrame(cursorLoop);
        return;
      }
      const c = q("[data-x='cursor']");
      if (c) {
        // Critically-damped-ish spring: gentle acceleration, soft arrival.
        cur.vx = (cur.vx + (cur.tx - cur.x) * 0.016) * 0.85;
        cur.vy = (cur.vy + (cur.ty - cur.y) * 0.016) * 0.85;
        cur.x += cur.vx;
        cur.y += cur.vy;
        c.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
      }
      // Camera rig: ease the zoom toward its target; while zoomed, either
      // track the cursor (clicks) or hold the narration's subject (points).
      // Runs for EVERYONE (the zooms are the content, see note above).
      {
        const camEl = q("[data-x='camera']");
        if (camEl) {
          const { w, h } = screenSize();
          if (cam.follow === "cursor") {
            cam.cx += (cur.x - cam.cx) * 0.055;
            cam.cy += (cur.y - cam.cy) * 0.055;
          } else if (cam.follow === "point") {
            cam.cx += (cam.px - cam.cx) * 0.065;
            cam.cy += (cam.py - cam.cy) * 0.065;
          } else {
            cam.cx += (w / 2 - cam.cx) * 0.06;
            cam.cy += (h / 2 - cam.cy) * 0.06;
          }
          // Gentle glide: visible but never jarring.
          cam.s += (cam.sT - cam.s) * 0.085;
          let tx = w / 2 - cam.s * cam.cx;
          let ty = h / 2 - cam.s * cam.cy;
          tx = Math.min(0, Math.max(w - cam.s * w, tx));
          ty = Math.min(0, Math.max(h - cam.s * h, ty));
          camEl.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.s})`;
          currentScale = cam.s;
        }
      }
      // Drive captions off the live voiceover position so the words on screen
      // track the spoken line exactly (no drift). Only while actually playing;
      // seek sweeps handle their own caption state.
      if (capState && !seeking) {
        const cs = capState;
        const per = cs.durMs / cs.chunks.length;
        // Small lead to counter the captions lagging behind the voice on
        // playback. This is an even-time-split approximation (the mp3s carry no
        // per-word timestamps), so it is a calibration, not frame-perfect. Tune
        // this single offset if the words drift ahead of or behind the audio.
        const idx = Math.floor((cs.a.currentTime * 1000 + 250) / per);
        if (cs.a.ended || idx >= cs.chunks.length) {
          if (cs.lastIdx !== -1) {
            setCaption([]);
            cs.lastIdx = -1;
          }
        } else if (idx !== cs.lastIdx) {
          cs.lastIdx = idx;
          setCaption(cs.chunks[idx], -1, 85);
        }
      }
      cursorRaf = requestAnimationFrame(cursorLoop);
    }

    function cursorTo(sel: string) {
      const el = q(sel);
      if (!el) return { x: cur.tx, y: cur.ty };
      const r = layoutRect(el);
      // Humans never click dead-center: land a little off-middle, varied
      // per click, so the motion reads like a real hand on a real mouse.
      cur.tx = r.x + r.w / 2 + (Math.random() - 0.5) * Math.min(10, r.w * 0.25);
      cur.ty = r.y + r.h / 2 + (Math.random() - 0.5) * Math.min(6, r.h * 0.25);
      return { x: cur.tx, y: cur.ty };
    }

    // A seek's event sweep only sets the cursor/camera TARGETS (cur.tx/ty,
    // cam.px/py/sT): actually applying them to the DOM normally happens
    // frame-by-frame inside cursorLoop's gentle-glide rig. cursorLoop skips
    // its whole body while paused (that's what holds the picture still for
    // an ordinary pause), so a seek committed while paused would otherwise
    // leave the cursor/camera drawn at their PRE-seek screen position
    // forever, then visibly whip to the correct spot the instant the video
    // resumes. Seeks are jump cuts already (every other piece of state
    // resets instantly), so snap the cursor and camera the same way, right
    // now, regardless of paused.
    function snapCameraAndCursor() {
      cur.x = cur.tx;
      cur.y = cur.ty;
      cur.vx = 0;
      cur.vy = 0;
      const c = q("[data-x='cursor']");
      if (c) c.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
      const camEl = q("[data-x='camera']");
      if (camEl) {
        const { w, h } = screenSize();
        if (cam.follow === "cursor") {
          cam.cx = cur.x;
          cam.cy = cur.y;
        } else if (cam.follow === "point") {
          cam.cx = cam.px;
          cam.cy = cam.py;
        } else {
          cam.cx = w / 2;
          cam.cy = h / 2;
        }
        cam.s = cam.sT;
        let tx = w / 2 - cam.s * cam.cx;
        let ty = h / 2 - cam.s * cam.cy;
        tx = Math.min(0, Math.max(w - cam.s * w, tx));
        ty = Math.min(0, Math.max(h - cam.s * h, ty));
        camEl.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.s})`;
        currentScale = cam.s;
      }
    }

    function fireRipple(x: number, y: number) {
      if (seeking) return;
      const r = q("[data-x='ripple']");
      if (!r) return;
      r.style.transform = `translate(${x}px, ${y}px)`;
      r.classList.remove(styles.rippleActive);
      void r.offsetWidth;
      r.classList.add(styles.rippleActive);
    }

    // Full click choreography: glide, squash, ripple, sound, then the UI
    // reacts 60ms later so the change reads as caused, not pre-baked.
    function clickOn(sel: string, delayMs: number, opts: { onHit?: () => void; zoom?: number; zoomMs?: number } = {}) {
      after(delayMs, () => {
        const { x, y } = cursorTo(sel);
        // Click zooms travel WITH the hand: cursor-follow mode.
        if (opts.zoom) after(80, () => followCursorZoom(opts.zoom));
        // Longer glide window to match the spring cursor. The cursor stays
        // perfectly still on click; the ripple and the pressed state carry
        // the feedback.
        after(760, () => {
          // Stop the hand cleanly on the target for the click. The spring has
          // already arrived by now, so DON'T hard-set the position: teleporting
          // the last few pixels reads as a flick (worst on the longer travels
          // like the category pills). Just kill the velocity so it rests.
          cur.vx = 0;
          cur.vy = 0;
          fireRipple(x, y);
          clickSound();
          after(60, () => {
            const el = q(sel);
            el?.classList.add(styles.pressed);
            opts.onHit?.();
            after(100, () => el?.classList.remove(styles.pressed));
            // Once the click lands, anchor the camera on the TARGET, not
            // the cursor: an idle mouse drifting to rest must not drag the
            // frame around.
            if (opts.zoom && cam.follow === "cursor") {
              cam.px = x;
              cam.py = y;
              cam.follow = "point";
            }
          });
        });
      });
    }

    function typeInto(sel: string, text: string, startDelay: number, onDone?: () => void, prefix = "") {
      after(startDelay, () => {
        const el = q(sel);
        if (!el) return;
        let i = 0;
        const hesitateAt = 4 + Math.floor(Math.random() * 4);
        const step = () => {
          if (i >= text.length) {
            onDone?.();
            return;
          }
          el.textContent = prefix + text.slice(0, i + 1);
          thock();
          i++;
          const delay = i === hesitateAt ? 210 : 42 + Math.random() * 34;
          if (i <= text.length) after(delay, step);
        };
        step();
      });
    }

    // ======================= CAPTIONS =======================
    function setCaption(words: string[], hiIndex = -1, stepMs = 120) {
      const layer = q("[data-x='captions']");
      if (!layer) return;
      layer.innerHTML = "";
      words.forEach((w, i) => {
        const span = document.createElement("span");
        span.className = cx(styles.capWord, i === hiIndex && styles.capHi);
        span.textContent = w;
        layer.appendChild(span);
        after(i * stepMs, () => span.classList.add(styles.pop));
      });
    }

    // Rough per-line durations (bytes / 96kbps) for caption pacing before
    // the audio's real duration is known.
    // Byte-derived from the actual Ava MP3s (96kbps): bytes / 12000 = sec.
    const VO_EST_MS: Record<VoKey, number> = {
      hook: 3360,
      address: 2450,
      dash: 5160,
      postjob: 4850,
      chat: 4200,
      booked: 2380,
      end: 2980,
    };

    // Captions ARE the narration: the spoken line renders in short chunks
    // (max 4 words) that pop in, hold, and get replaced by the next chunk,
    // so they never wrap off screen. A small lead-in keeps text from
    // beating the audio onset, and the whole thing clears when the line
    // ends, synced to the real audio duration.
    function captionVo(key: VoKey, offsetMs = 0) {
      const words = VO_TEXT[key].split(" ");
      const a = voAudios[key];
      const durMs =
        a && isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : VO_EST_MS[key];
      // Two words on screen at a time: reads fast, never crowds the frame.
      const CHUNK = 2;
      const chunks: string[][] = [];
      for (let i = 0; i < words.length; i += CHUNK) chunks.push(words.slice(i, i + CHUNK));
      // Preferred path: when the real MP3 will play, hand the chunks to
      // cursorLoop, which advances them off a.currentTime every frame so the
      // words on screen always match the voice (no drift), and pause/seek come
      // for free because currentTime already reflects them.
      if (a && !isMuted) {
        capState = { a, chunks, durMs, lastIdx: -2 };
        return;
      }
      // Muted or no audio: fall back to an estimated even schedule so a muted
      // viewer still gets captions.
      capState = null;
      const LEAD = 90;
      const per = (durMs * 0.92) / chunks.length;
      chunks.forEach((chunk, ci) => {
        const at = LEAD + ci * per - offsetMs;
        const nextAt = LEAD + (ci + 1) * per - offsetMs;
        if (at <= 0 && nextAt > 0) setCaption(chunk, -1, 85); // mid-line resume shows the live chunk
        else if (at > 0) after(at, () => setCaption(chunk, -1, 85));
      });
      const clearAt = LEAD + durMs + 150 - offsetMs;
      if (clearAt > 0) after(clearAt, () => setCaption([]));
    }

    // ======================= PAGES =======================
    function showPage(id: string, opts: { whoosh?: boolean; up?: boolean } = {}) {
      const pages = qa("[data-page]");
      const target = pages.find((p) => p.getAttribute("data-page") === id);
      if (!target) return;
      pages.forEach((p) => {
        if (p === target) return;
        if (p.classList.contains(styles.active)) {
          p.classList.add(styles.exitLeft);
          // This is a wall-clock cleanup (not the virtual clock), so while
          // paused it must re-schedule itself instead of firing mid-pause
          // and stripping classes off a frozen frame.
          const cleanup = () => {
            if (paused) {
              timers.push(setTimeout(cleanup, 120));
              return;
            }
            // A page can be re-activated within 170ms (seek sweeps replay
            // scenes instantly); never strip .active off the CURRENT page.
            if (p !== activePage) p.classList.remove(styles.active);
            p.classList.remove(styles.exitLeft);
          };
          timers.push(setTimeout(cleanup, 170));
        }
      });
      cameraSnapWide();
      target.classList.remove(styles.exitLeft);
      target.classList.add(styles.active);
      activePage = target;
      punchCamera();
      if (opts.whoosh) whoosh(opts.up ?? true);
    }

    // A scene cut's outgoing page fades/slides via a real CSS `transition`
    // (see .page in the stylesheet), not a @keyframes animation, so the
    // isPaused class's `animation-play-state: paused` hook has no effect on
    // it: left alone, it keeps animating on real wall-clock time even while
    // the rest of the picture is frozen. Whichever page painted LATER in
    // this DOM (e.g. the very first hook -> address cut, where onboardPage
    // sits before dashPage) can render visibly ON TOP of the frozen page
    // underneath while it finishes its fade/slide. Snapshot the live
    // computed value and pin it with an inline style + transition:none so
    // pausing genuinely halts it; clearing the inline override on resume
    // lets the class-driven transition continue from exactly there.
    function freezePageTransitions() {
      qa("[data-page]").forEach((el) => {
        const cs = getComputedStyle(el);
        el.style.opacity = cs.opacity;
        el.style.transform = cs.transform;
        el.style.transition = "none";
      });
    }
    function unfreezePageTransitions() {
      qa("[data-page]").forEach((el) => {
        el.style.opacity = "";
        el.style.transform = "";
        el.style.transition = "";
      });
    }

    // Count-ups run on the VIRTUAL clock (scheduled via after), so they
    // freeze with pause, scale with playback rate, and resolve instantly
    // to the final value inside a seek fast-forward.
    function countUp(sel: string, to: number, durMs: number, from = 0, onDone?: () => void) {
      const el = q(sel);
      if (!el) return;
      if (seeking) {
        el.textContent = String(to);
        onDone?.();
        return;
      }
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        after((durMs * i) / steps, () => {
          const p = i / steps;
          const eased = 1 - Math.pow(1 - p, 3);
          const node = q(sel);
          if (node) node.textContent = String(Math.round(from + (to - from) * eased));
          if (i === steps) onDone?.();
        });
      }
    }

    function setChip(text: string | null) {
      const chip = q("[data-x='stepChip']");
      if (!chip) return;
      if (!text) {
        chip.classList.remove(styles.show);
      } else {
        chip.textContent = "Step " + text;
        chip.classList.add(styles.show);
      }
    }

    function impactVisual() {
      if (fxReduced || seeking) return;
      const dev = q("[data-x='device']");
      const flash = q("[data-x='flash']");
      if (dev) {
        dev.classList.remove(styles.shake);
        void dev.offsetWidth;
        dev.classList.add(styles.shake);
      }
      if (flash) {
        flash.classList.remove(styles.flashActive);
        void flash.offsetWidth;
        flash.classList.add(styles.flashActive);
      }
    }

    // ======================= SCENE CHOREOGRAPHY =======================
    // Each enter function receives 0ms = its scene start. Captions are
    // driven by the narration lines (playVo), so what you read matches what
    // you hear; extra setCaption calls are gone by design.

    // Quick pop-zoom: overshoot the target scale, let the rig settle it.
    function popZoom(sel: string, scale = 1.8) {
      focusOn(sel, scale);
      cam.s = Math.max(cam.s, scale + 0.16);
    }

    function enterHook() {
      // Cold open: the centered Hearth logo card is on screen from the very
      // first frame (no fade-in, no URL typing), lingers a moment while
      // "This is Hearth" begins, then fades away to reveal the website.
      showPage("dashPage");
      cameraSnapWide();
      const s = q("[data-x='score']");
      if (s) s.textContent = "71";
      const intro = q("[data-x='intro']");
      if (intro) {
        // Visible instantly: suppress the fade-in for frame zero.
        intro.style.transition = "none";
        intro.classList.add(styles.show);
        void intro.offsetWidth;
        intro.style.transition = "";
      }
      after(700, () => playVo("hook"));
      after(2100, () => intro?.classList.remove(styles.show));
      after(2900, () => focusOn("[data-x='scoreCard']", 1.2));
    }

    function enterAddress() {
      // Cut starts ALREADY zoomed on the subject: no zoom-in-then-out.
      showPage("onboardPage", { whoosh: true });
      cameraSnapTo("[data-x='addrInput']", 1.15);
      playVo("address");
      const t = q("[data-x='typed']");
      if (t) t.textContent = "";
      q("[data-x='addrHint']")?.classList.remove(styles.show);
      q("[data-x='addrInput']")?.classList.remove(styles.focus);
      clickOn("[data-x='addrInput']", 150, {
        onHit: () => {
          q("[data-x='addrInput']")?.classList.add(styles.focus);
          typeInto("[data-x='typed']", "123 Maple St", 300, () => {
            q("[data-x='addrHint']")?.classList.add(styles.show);
          });
        },
      });
      clickOn("[data-x='findBtn']", 2500, { onHit: () => undefined });
    }

    function enterDash() {
      // One still shot: framed on the dashboard while the score counts up and
      // the cursor checks off a reminder. No camera pans or cursor-chasing
      // zooms; the frame holds so the eye can actually read the page.
      showPage("dashPage", { whoosh: true });
      // Wide (whole dashboard in frame) so nothing is cut off the bottom in the
      // inline, non-fullscreen player, and the reminder the cursor checks is
      // always visible.
      cameraSnapWide();
      playVo("dash");
      const s = q("[data-x='score']");
      if (s) s.textContent = "0";
      countUp("[data-x='score']", 71, 800);
      // Check off a reminder (cursor moves, camera stays put).
      atBeat(9, () => {
        clickOn("[data-x='remCheck']", 0, {
          onHit: () => {
            q("[data-x='remCheck']")?.classList.add(styles.done);
            q("[data-x='remTitle']")?.classList.add(styles.done);
          },
        });
      });
    }

    function enterPostjob() {
      // Cut opens already framed on the title box the cursor is about to
      // type into.
      // One still shot framed on the form; the cursor fills it out (title,
      // category, timing, post) with the camera holding. Then a single move:
      // pull wide so the notification can pop in view. No per-click zooms.
      showPage("postjobPage", { whoosh: true });
      cameraSnapTo("[data-x='jobTitleBox']", 1.1);
      playVo("postjob");
      const titleEl = q("[data-x='jobTitle']");
      if (titleEl) titleEl.textContent = "";
      // Type what's actually wrong, like a real person filling the form.
      clickOn("[data-x='jobTitleBox']", 200, {
        // Type the whole title FIRST, then reach for the mouse: a real person
        // types the problem, then picks the category and timing. Previously the
        // cursor slid to the category pill mid-typing, which read as unnatural.
        onHit: () =>
          typeInto("[data-x='jobTitle']", "Leaking kitchen faucet", 60, () => {
            clickOn("[data-pill='plumbing']", 200, {
              onHit: () => q("[data-pill='plumbing']")?.classList.add(styles.on),
            });
            clickOn("[data-pill='week']", 200 + 1.2 * BEAT_MS, {
              onHit: () => q("[data-pill='week']")?.classList.add(styles.on),
            });
          }),
      });
      clickOn("[data-x='postBtn']", 7.8 * BEAT_MS, {
        onHit: () => {
          q("[data-x='toast']")?.classList.add(styles.show);
        },
      });
      // The one deliberate move: pull wide so the notification pops in frame
      // (the demo's ONE ding), then the homeowner opens Messages.
      atBeat(9.4, () => cameraWide(400));
      atBeat(10.6, () => {
        q("[data-x='notif']")?.classList.add(styles.show);
        coin();
      });
      clickOn("[data-x='msgTab']", 11.8 * BEAT_MS);
    }

    function enterChat() {
      // Homeowner's Messages page, driven like a real session: the pro's
      // quote pops in, the homeowner types a reply and sends it, and the job
      // is booked off that reply. Scene beat 13 = global beat 63 = the drop.
      showPage("chatPage", { whoosh: true });
      const b1 = q("[data-x='b1']");
      const b2 = q("[data-x='b2']");
      const booked = q("[data-x='booked']");
      const replyText = "Thursday works great.";
      const typedReply = q("[data-x='typedReply']");
      if (typedReply) typedReply.textContent = "";
      b1?.classList.remove(styles.show);
      b2?.classList.remove(styles.show);
      booked?.classList.remove(styles.show);
      // The pro's message arrives after the page opens, like a real inbox.
      atBeat(1, () => {
        b1?.classList.add(styles.show);
        playVo("chat");
      });
      cameraSnapTo("[data-x='thread']", 1.15);
      // Homeowner types a reply and sends it, like a normal person would;
      // the camera holds on the thread the whole time (no dive-in zoom).
      clickOn("[data-x='chatInput']", 2.2 * BEAT_MS, {
        onHit: () => {
          q("[data-x='chatInput']")?.classList.add(styles.focus);
          typeInto("[data-x='typedReply']", replyText, 80, () => {
            // Reply is fully typed: give it a half beat, THEN click Send, so
            // Send never fires while the words are still appearing.
            after(0.5 * BEAT_MS, () => {
              clickOn("[data-x='sendBtn']", 0, {
                onHit: () => {
                  if (typedReply) typedReply.textContent = "";
                  q("[data-x='chatInput']")?.classList.remove(styles.focus);
                  if (b2) {
                    b2.textContent = replyText;
                    b2.classList.add(styles.show);
                  }
                },
              });
            });
          });
        },
      });
      // The reply is the last thing the homeowner does; the pro confirms and
      // the job books off it, no separate "accept quote" button to press.
      atBeat(13, () => {
        booked?.classList.add(styles.show);
        focusOn("[data-x='booked']", 1.3);
        impactVisual();
        setCaption([]);
      });
      atBeat(14.4, () => playVo("booked"));
      atBeat(17, () => cameraWide(600));
    }

    function enterEnd() {
      showPage("endPage", { whoosh: true });
      // Let the "Booked. That easy." line FULLY finish before the closer
      // starts (Ava's read is a touch longer than Andrew's was).
      atBeat(2.2, () => playVo("end"));
      const es = q("[data-x='endScore']");
      if (es) es.textContent = "71";
      // Resolve the numeric open loop from the hook: 71 climbs to 96.
      after(700, () => countUp("[data-x='endScore']", 96, 800, 71));
    }

    const ENTER: Record<string, () => void> = {
      hook: enterHook,
      address: enterAddress,
      dash: enterDash,
      postjob: enterPostjob,
      chat: enterChat,
      end: enterEnd,
    };

    // ======================= TIMELINE =======================
    const fillEl = q("[data-x='fill']");
    const counterEl = q("[data-x='counter']");
    if (counterEl) counterEl.textContent = `${fmt(0)} / ${fmt(TOTAL_MS)}`;

    let playing = false;
    let rafHandle: number | null = null;
    let effTotalMs = TOTAL_MS; // wall-clock runtime at the active rate

    function runScene(index: number) {
      if (index >= SCENES.length) {
        finishTour();
        return;
      }
      if (index === 0) {
        // Timeline-wide events register here (not in play) so seeks, which
        // rebuild via runScene(0), replay them too. Mid-roll CTA at ~21s.
        after(56 * BEAT_MS, () => q("[data-x='midCta']")?.classList.add(styles.show));
      }
      const sc = SCENES[index];
      setChip(sc.step);
      ENTER[sc.id]?.();
      after(sc.beats * BEAT_MS, () => runScene(index + 1));
    }

    function tick(ts: number) {
      if (!playing) return;
      if (lastTickTs === null) lastTickTs = ts;
      // Clamp: rAF stops in hidden tabs, so an unclamped delta after tab
      // return would machine-gun every queued event and desync the music.
      const delta = Math.min(ts - lastTickTs, 100);
      lastTickTs = ts;
      if (!paused && !clockHold) {
        vnow = Math.min(vnow + delta, effTotalMs);
        fireDueEvents();
        // The final scene-boundary event drifts a few ms past effTotalMs:
        // fireDueEvents nudges vnow up to each fired event's own instant, so
        // every scene cut bases its next `after` a frame late and the drift
        // accumulates. On an unbroken playthrough vnow clamps at effTotalMs
        // before that last event is ever due, so runScene(len)/finishTour
        // never run, the replay overlay never shows, and the demo hangs on
        // the silent end card with both rAF loops spinning. Close it out the
        // moment the clock reaches the end, matching seekTo's own end guard.
        // Guarded by `playing` so the rare exact-boundary event that already
        // fired finishTour itself can't double-fire it; only tick reaches
        // this, never the seek sweep (which runs fireDueEvents from vnow=0).
        if (playing && vnow >= effTotalMs) {
          finishTour();
          return;
        }
      }
      // While the user drags the seek bar, the preview owns these writes.
      if (!scrubbing) {
        const p = vnow / effTotalMs;
        if (fillEl) fillEl.style.width = `${p * 100}%`;
        const seekEl = q<HTMLInputElement>("[data-x='seek']");
        if (seekEl) seekEl.value = String(Math.round(p * 1000));
        // Counter shows content time (like a video player), not wall clock.
        if (counterEl) counterEl.textContent = `${fmt(p * TOTAL_MS)} / ${fmt(TOTAL_MS)}`;
      }
      if (playing) rafHandle = requestAnimationFrame(tick);
    }

    function finishTour() {
      playing = false;
      stopMusic();
      if (cursorRaf) cancelAnimationFrame(cursorRaf);
      cursorRaf = null;
      if (fillEl) fillEl.style.width = "100%";
      if (counterEl) counterEl.textContent = `${fmt(TOTAL_MS)} / ${fmt(TOTAL_MS)}`;
      // Let the end card (real CTA link, final score) breathe before the
      // replay overlay covers it: the last 2 seconds sell the signup.
      timers.push(setTimeout(() => setFinished(true), 2600));
    }

    function resetState() {
      qa("[data-pill]").forEach((p) => p.classList.remove(styles.on));
      q("[data-x='toast']")?.classList.remove(styles.show);
      q("[data-x='booked']")?.classList.remove(styles.show);
      q("[data-x='remCheck']")?.classList.remove(styles.done);
      q("[data-x='remTitle']")?.classList.remove(styles.done);
      q("[data-x='midCta']")?.classList.remove(styles.show);
      q("[data-x='notif']")?.classList.remove(styles.show);
      q("[data-x='intro']")?.classList.remove(styles.show);
      const capLayer = q("[data-x='captions']");
      if (capLayer) capLayer.innerHTML = "";
      q("[data-x='chatInput']")?.classList.remove(styles.focus);
      const typedReply = q("[data-x='typedReply']");
      if (typedReply) typedReply.textContent = "";
      const b2 = q("[data-x='b2']");
      if (b2) {
        b2.textContent = "";
        b2.classList.remove(styles.show);
      }
      const c = q("[data-x='cursor']");
      if (c) c.style.opacity = "1";
      cur.x = 240;
      cur.y = 140;
      cur.tx = 300;
      cur.ty = 160;
    }

    function play() {
      if (playing) return;
      // Created/resumed synchronously in the click handler: valid gesture.
      ensureAudio();
      playing = true;
      paused = false;
      boxEl.classList.remove(styles.isPaused);
      // Defensive: a seek-to-end committed while still paused (finishTour
      // can fire mid-pause, e.g. dragging the scrubber to 100% without ever
      // resuming) re-pins the page freeze and nothing else ever clears it,
      // since togglePause's own unfreeze only runs on an actual resume.
      // Without this, replaying would leave every page's opacity/transform
      // stuck on its stale inline value from the last frozen session.
      unfreezePageTransitions();
      vnow = 0;
      lastTickTs = null;
      events = [];
      effTotalMs = TOTAL_MS / rate;
      if (fillEl) fillEl.style.width = "0%";
      timers.forEach(clearTimeout);
      timers.length = 0;
      resetState();
      stopVo();
      initVoAudio();
      pickVoice();
      // Kick off the music scheduler and the first tick only once the
      // context is actually running: starting them against a still-frozen
      // ctx.currentTime anchors every beat late for the whole run.
      const go = () => {
        startMusic();
        if (!cursorRaf) cursorLoop();
        runScene(0);
        rafHandle = requestAnimationFrame(tick);
      };
      if (ctx && ctx.state !== "running") {
        ctx.resume().then(go).catch(go);
      } else {
        go();
      }
    }

    function toggleMute(): boolean {
      const next = !isMuted;
      setMutedInternal(next);
      return next;
    }

    // Pause freezes the virtual clock (visual timeline) and suspends the
    // AudioContext (every scheduled note) in the same call, so resume picks
    // both up exactly where they stopped. Returns null when there was
    // nothing playing to pause (e.g. the finishTour end window), so the
    // caller can treat that tap as "restart" instead of a dead button.
    function togglePause(): boolean | null {
      if (!playing) return null;
      paused = !paused;
      const gen = ++pauseGen;
      boxEl.classList.toggle(styles.isPaused, paused);
      // isPaused only freezes @keyframes animations; a scene cut's page
      // fade/slide is a CSS transition, which that hook can't touch (see
      // freezePageTransitions' comment), so it needs its own explicit hold.
      if (paused) freezePageTransitions();
      else unfreezePageTransitions();
      // File-based narration pauses and resumes mid-line cleanly. The
      // speechSynthesis fallback just cancels on pause (Chrome's
      // pause()/resume() is unreliable enough to wedge the queue).
      if (paused) {
        // PAUSING: fade the output to near-silent BEFORE the context
        // actually suspends, so the freeze lands as a quick fade instead of
        // an audible click/pop cutting a live waveform mid-cycle.
        if (ctx && outGain) {
          const t = ctx.currentTime;
          outGain.gain.cancelScheduledValues(t);
          outGain.gain.setValueAtTime(outGain.gain.value, t);
          outGain.gain.linearRampToValueAtTime(0.0001, t + 0.025);
        }
        timers.push(
          setTimeout(() => {
            // Stale gen (a resume happened since) or already unpaused:
            // never suspend out from under a later toggle.
            if (gen === pauseGen && paused) ctx?.suspend();
          }, 40)
        );
        currentVo?.pause();
        stopSpeech();
      } else {
        // RESUMING: hold the virtual clock until the context is confirmed
        // running again, so vnow can't race ahead of audio that hasn't
        // actually restarted yet.
        clockHold = true;
        const finishResume = () => {
          if (gen !== pauseGen) return; // superseded by a later toggle
          clockHold = false;
          lastTickTs = null;
          if (ctx && outGain) {
            const t = ctx.currentTime;
            outGain.gain.cancelScheduledValues(t);
            outGain.gain.setValueAtTime(outGain.gain.value, t);
            outGain.gain.linearRampToValueAtTime(outGainTarget(), t + 0.025);
          }
          // Resync the voiceover to the instant playback actually resumes
          // at, using the same offset math seekTo uses for a mid-line
          // resume, then play it (never while muted or already ended).
          if (currentVo && lastVoKey && !isMuted && !currentVo.ended) {
            const offsetMs = Math.max(0, (vnow - lastVoStartV) * rate);
            currentVo.currentTime = offsetMs / 1000;
            currentVo.play().catch(() => undefined);
          }
        };
        if (ctx) ctx.resume().then(finishResume).catch(finishResume);
        else finishResume();
      }
      return paused;
    }

    function setRateInternal(r: number) {
      if (r <= 0 || r === rate) return;
      const wasFrac = playing ? (vnow / effTotalMs) : 0;
      rate = r;
      if (playing) {
        // Retiming already-scheduled Web Audio events is not safe, so a
        // speed change rebuilds through the seek pipeline AND KEEPS YOUR
        // PLACE (a speed control that restarts drives away the exact
        // viewers who use it). seekTo preserves the paused flag, so doing
        // this while paused just re-times the frozen timeline in place
        // instead of leaving music/events/effTotalMs desynced for when the
        // viewer resumes.
        playing = false;
        stopMusic();
        stopVo();
        if (rafHandle) cancelAnimationFrame(rafHandle);
        seekTo(wasFrac);
      }
      // seekTo never touches the paused flag, so a rate change while paused
      // rebuilds the timeline in place and stays paused; it must NOT
      // secretly unpause (the old behavior inverted the pause button). On
      // the poster or the end card (not playing) the new rate simply
      // applies to the next play.
    }

    // YouTube-style scrubbing. Backward seeks are a silent replay from zero:
    // reset all state, fast-forward the event queue to the target instant
    // (SFX and one-shot visuals muted by the `seeking` flag), then restart
    // the music scheduler mid-song at the matching beat.
    function seekTo(frac: number) {
      ensureAudio();
      const contentMs = Math.min(1, Math.max(0, frac)) * TOTAL_MS;
      stopMusic();
      stopVo();
      // stopVo() above only stops the AUDIO ELEMENT that was playing; it
      // does not know which line SHOULD be resumed after the sweep below.
      // Without clearing these too, a seek to before the first VO cue the
      // sweep can reach (most obviously the start, before hook's line fires
      // at 700ms) leaves lastVoKey pointing at whatever line was playing
      // BEFORE the seek. The mid-sentence resume block further down would
      // then restart that stale, wrong line from 0, only to have it cut off
      // a beat later when the sweep's own freshly-scheduled playVo() fires
      // for real: that overlap/cut is the "voice over glitches" bug. Reset
      // here so the resume block only ever sees a key the sweep itself
      // re-established for the seeked-to instant.
      lastVoKey = null;
      lastVoStartV = 0;
      // Rate may have changed while idle/paused; recompute like play() does.
      effTotalMs = TOTAL_MS / rate;
      // Scrub is over the moment a seek commits: restore output FIRST so no
      // early return below can strand the player silent.
      scrubbing = false;
      applyOutGain();
      // Drop any pause-time page freeze BEFORE the sweep below changes
      // page classes: an inline style always wins over a class rule no
      // matter what the classes say, so leaving a stale freeze in place
      // here would pin every page to its PRE-seek look even after the
      // sweep activates a different one. Re-frozen at the correct new
      // state below once the sweep (and the camera/cursor snap) settle.
      unfreezePageTransitions();
      seeking = true;
      events = [];
      timers.forEach(clearTimeout);
      timers.length = 0;
      resetState();
      // Chronological sweep from zero to the target: every event fires with
      // the virtual clock set to its own instant, so nested chains replay
      // in place instead of leaking past the seek and firing on the wrong
      // screen (the bug that made scrubbing break the video).
      vnow = 0;
      runScene(0);
      fireDueEvents(Math.min(contentMs / rate, effTotalMs));
      seeking = false;
      // cursorLoop is the only thing that normally paints cur.x/y and the
      // camera transform to the DOM, and it skips its whole body while
      // paused: without this, a seek committed while paused would leave the
      // cursor/camera drawn at their PRE-seek position until an eventual
      // resume, which would then visibly whip to the correct spot instead
      // of already being framed there. Seeks are jump cuts already, so snap
      // both now regardless of paused.
      snapCameraAndCursor();
      // Re-pin the freeze at the just-seeked-to state (see the unfreeze
      // above): with transitions back on, this happens instantly, before
      // the browser's next paint, so a paused scrub never shows a 150ms
      // fade/slide into the new frame, only an instant cut.
      if (paused) freezePageTransitions();
      // Resume the narration MID-SENTENCE at the exact word this instant
      // lands on: captions pick up at the live chunk and, if unmuted, the
      // audio seeks to the same offset (skipping around must never leave
      // the voice saying nothing).
      // Read through a widening assertion: TS's control-flow analysis
      // can't see that the sweep above may have reassigned lastVoKey (the
      // write happens inside playVo, reached only indirectly via a stored
      // callback in fireDueEvents), so without this it wrongly keeps the
      // "= null" a few lines up narrowed all the way here.
      const voKey = lastVoKey as VoKey | null;
      if (voKey) {
        const a = voAudios[voKey];
        const durMs =
          a && isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : VO_EST_MS[voKey];
        const offsetMs = Math.max(0, (vnow - lastVoStartV) * rate);
        if (offsetMs < durMs) {
          captionVo(voKey, offsetMs);
          if (!isMuted && a) {
            a.currentTime = offsetMs / 1000;
            a.volume = Math.min(1, userVolume);
            a.playbackRate = rate;
            currentVo = a;
            // Seeking while paused must stay silent: togglePause's resume
            // branch is what actually starts this element playing again.
            if (!paused) a.play().catch(() => undefined);
          }
        }
      }
      lastTickTs = null;
      if (vnow >= effTotalMs) {
        finishTour();
        return;
      }
      if (!playing) {
        playing = true;
        setFinished(false);
      }
      startMusic(contentMs);
      if (ctx && ctx.state === "suspended" && !paused) ctx.resume();
      if (!cursorRaf) cursorLoop();
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(tick);
    }

    // While the user drags the seek bar, silence everything: audio churning
    // under a scrub sounds like glitching. seek() on release restores it.
    function scrubStart() {
      scrubbing = true;
      applyOutGain();
      stopVo();
    }

    engineRef.current = { play, toggleMute, togglePause, setVolume: setVolumeInternal, setRate: setRateInternal, seek: seekTo, scrubStart };

    function onVisibility() {
      if (document.hidden) {
        ctx?.suspend();
        // Only if the USER hadn't already paused: togglePause's own pause
        // branch already owns currentVo when that's the reason it's frozen.
        if (!paused) currentVo?.pause();
      } else {
        // Reset the frame clock so the first tick back has ~zero delta
        // (rAF slept the whole time the tab was hidden).
        lastTickTs = null;
        // Never force-resume while the USER paused: coming back to the tab
        // was restarting the music under frozen visuals.
        if (ctx && playing && !paused) {
          ctx.resume();
          if (currentVo && !currentVo.ended) currentVo.play().catch(() => undefined);
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      timers.forEach(clearTimeout);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      if (cursorRaf) cancelAnimationFrame(cursorRaf);
      stopMusic();
      stopVo();
      if (ctx) {
        try {
          ctx.close();
        } catch {
          /* already closed */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the fullscreen icon in sync with actual fullscreen state (covers
  // the Escape key and browser chrome exits, plus Safari's prefixed event).
  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(fullscreenTarget()));
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  // CSS maximize fallback (iPhone Safari): Escape closes, page scroll locks.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [maximized]);

  function handlePlay() {
    setFinished(false);
    setStarted(true);
    setPaused(false);
    engineRef.current?.play();
    track("hero_demo_play");
  }

  function handleTogglePause() {
    const next = engineRef.current?.togglePause();
    // null = there was nothing playing to pause (e.g. tapping during the
    // finishTour end window, before the replay overlay has shown up yet):
    // treat that tap as "restart" instead of a dead control.
    if (next === null) {
      handlePlay();
      return;
    }
    setPaused(next ?? false);
  }

  // Clicking the picture toggles pause, like every video player.
  function handleScreenClick() {
    if (started && !finished) handleTogglePause();
  }

  // YouTube-style scrubbing: while dragging, only the bar preview moves and
  // the audio is silenced; the actual seek commits once, on release. This is
  // what stops rapid drag events from restarting the timeline dozens of
  // times a second (the old break) and the audio from stuttering.
  const scrubbingRef = useRef(false);

  function handleSeekPreview(e: { currentTarget: HTMLInputElement }) {
    if (!started) return;
    if (!scrubbingRef.current) {
      scrubbingRef.current = true;
      engineRef.current?.scrubStart();
    }
    const p = Number(e.currentTarget.value) / 1000;
    const box = boxRef.current;
    const fill = box?.querySelector<HTMLElement>("[data-x='fill']");
    if (fill) fill.style.width = `${p * 100}%`;
    const counter = box?.querySelector<HTMLElement>("[data-x='counter']");
    if (counter) counter.textContent = `${fmt(p * TOTAL_MS)} / ${fmt(TOTAL_MS)}`;
  }

  function handleSeekCommit(e: { currentTarget: HTMLInputElement }) {
    if (!started || !scrubbingRef.current) return;
    scrubbingRef.current = false;
    setFinished(false);
    engineRef.current?.seek(Number(e.currentTarget.value) / 1000);
  }

  function handleToggleMute() {
    const next = engineRef.current?.toggleMute() ?? false;
    setMuted(next);
  }

  function handleVolume(e: ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value);
    setVolume(v);
    engineRef.current?.setVolume(v / 100);
  }

  function handleCycleRate() {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    engineRef.current?.setRate(RATES[next]);
  }

  function handleToggleFullscreen() {
    const shell = shellRef.current;
    if (!shell) return;
    if (fullscreenTarget()) {
      const d = document as FsDocument;
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
      else d.webkitExitFullscreen?.();
      return;
    }
    if (maximized) {
      setMaximized(false);
      return;
    }
    const el = shell as FsElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => setMaximized(true));
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else {
      // iPhone Safari: element fullscreen unsupported, use CSS maximize.
      setMaximized(true);
    }
  }

  const isFull = fullscreen || maximized;

  return (
    <div ref={shellRef} className={cx(styles.shell, maximized && styles.shellMax)}>
    <div
      ref={boxRef}
      className={styles.box}
      role="group"
      aria-label="Hearth product demo, about 30 seconds, with sound"
      aria-describedby="hero-demo-desc"
    >
      <p id="hero-demo-desc" className="sr-only">
        A fast animated walkthrough of Hearth. A homeowner types their address, sees their home&apos;s
        health score and an alert the app caught, checks off a maintenance reminder, and posts a
        plumbing job with the price shown up front. Then a local pro browses open jobs, applies,
        and wins the job through an in-app chat thread. On-screen captions describe each step.
      </p>

      <span className={styles.watermark}>
        <HouseMark />
        Hearth
      </span>
      <span className={styles.stepChip} data-x="stepChip"></span>
      <Link
        href="/homeowner-signup"
        className={styles.midCta}
        data-x="midCta"
        onClick={(e) => e.stopPropagation()}
      >
        Free to try, no card needed
      </Link>

      <div className={styles.deviceWrap} onClick={handleScreenClick}>
        <div className={styles.device} data-x="device">
          <div className={styles.deviceChrome}>
            <span className={styles.dot}></span>
            <span className={styles.dot}></span>
            <span className={styles.dot}></span>
            <span className={styles.addr}>hearth.app</span>
          </div>
          <div className={styles.deviceScreen} data-x="screen">
            <div className={styles.camera} data-x="camera">
              {/* ---------- Onboarding page (real site classes) ---------- */}
              <div className={styles.page} data-page="onboardPage">
                <header className="flex items-center gap-2 border-b border-stone-200/70 bg-white/80 px-6 py-3 text-lg font-semibold text-stone-900">
                  <Logo className="h-6 w-6 text-hearth-700" /> Hearth
                </header>
                <div className="mx-auto max-w-md px-6 pt-12">
                  <h1 className="text-2xl font-semibold text-stone-900">Find your home</h1>
                  <p className="mt-1 text-sm text-stone-600">Your address is all it takes to start.</p>
                  <div className={cx("input mt-5 flex items-center")} data-x="addrInput">
                    <span data-x="typed"></span>
                    <span className={styles.caret}>|</span>
                  </div>
                  <p className={cx("mt-2 text-sm text-green-700", styles.applied)} data-x="addrHint">
                    Built 1978 · 1,640 sqft · 3 bd / 2 ba
                  </p>
                  <div className="mt-4">
                    <span className="btn-primary" data-x="findBtn">Find my home</span>
                  </div>
                </div>
              </div>

              {/* ---------- Homeowner dashboard (copied from the live app's
                   screenshot: property header, four stat cards, This month
                   with the briefing) ---------- */}
              <div className={styles.page} data-page="dashPage">
                <AppNav logoX />
                <div className="mx-auto max-w-5xl px-6 py-5">
                  <h1 className="text-xl font-semibold text-stone-900">
                    123 Maple St, Your City
                  </h1>
                  <p className="mt-0.5 text-sm text-stone-500">Built 1978 · 1640 sqft · 3 bd / 2 ba</p>
                  <p className="mt-0.5 text-sm text-red-600" data-x="brokenLink">Something broken right now?</p>
                  <div className="mt-4 grid grid-cols-4 gap-4">
                    <div className="card-hero" data-x="scoreCard">
                      <p className="stat-label">Home Health Score</p>
                      <p className="stat-label">Estimated score</p>
                      <p className="stat-number mt-1 text-4xl" data-x="score">0</p>
                      <p className="mt-1 text-sm text-stone-600">
                        Based on your home&apos;s age. Confirm your systems to sharpen it.
                      </p>
                      <p className="mt-2 text-sm text-stone-600">▸ Why this score?</p>
                      <p className="mt-2 text-sm text-stone-600">
                        Biggest win: <span className="underline">confirm your plumbing (+15 pts)</span>
                      </p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Open jobs</p>
                      <p className="stat-number mt-1 text-3xl">3</p>
                      <p className="mt-2 text-sm text-hearth-700">View job postings →</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Home value</p>
                      <p className="mt-1 text-lg font-bold text-stone-900">Track your home&apos;s value</p>
                      <p className="mt-1 text-sm text-stone-600">
                        See what your home is likely worth today and how much equity you have.
                      </p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Energy this season</p>
                      <p className="stat-number mt-1 text-2xl">~$293-544</p>
                      <p className="mt-1 text-sm text-stone-600">to stay cool this summer</p>
                    </div>
                  </div>
                  <h2 className="mt-5 text-lg font-semibold text-stone-900">This month</h2>
                  <div className="card mt-2" data-x="briefing">
                    <p className="stat-label">
                      Hearth&apos;s briefing
                    </p>
                    <div className="mt-2 space-y-1.5 text-sm text-stone-700">
                      <p>
                        • Your plumbing is near the end of its life. It is worth planning ahead.{" "}
                        <span className="text-hearth-700">Plan it →</span>
                      </p>
                      <p>
                        • Your roof is near the end of its life. It is worth planning ahead.{" "}
                        <span className="text-hearth-700">Plan it →</span>
                      </p>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-sm text-stone-600">
                      <span>19 tasks on your plan</span>
                      <span className="text-xs text-stone-500">2 of 19 done</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
                      <div className="h-full w-[12%] rounded-full bg-green-500"></div>
                    </div>
                    <div className="mt-3 flex items-center gap-3 border-t border-stone-100 pt-3 text-sm text-stone-800">
                      <span className={styles.checkCircle} data-x="remCheck">✓</span>
                      <span className={styles.strike} data-x="remTitle">Flush the water heater</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ---------- Post a job page (real site classes) ---------- */}
              <div className={styles.page} data-page="postjobPage">
                <AppNav active={2} msgTabX msgBadge />
                <div className="relative mx-auto max-w-5xl px-6 py-6">
                  <h1 className="text-2xl font-semibold text-stone-900">Post a job</h1>
                  <p className="label mt-3">What&apos;s wrong?</p>
                  <div className="input flex max-w-md items-center" data-x="jobTitleBox">
                    <span data-x="jobTitle"></span>
                    <span className={styles.caret}>|</span>
                  </div>
                  <p className="label mt-3">What do you need?</p>
                  <div className="flex flex-wrap gap-2">
                    <span className={styles.pill} data-pill="plumbing">Plumbing</span>
                    <span className={styles.pill} data-pill="electrical">Electrical</span>
                    <span className={styles.pill} data-pill="hvac">HVAC</span>
                  </div>
                  <p className="label mt-4">When?</p>
                  <div className="flex flex-wrap gap-2">
                    <span className={styles.pill} data-pill="week">This week</span>
                    <span className={styles.pill} data-pill="flex">Flexible</span>
                  </div>
                  <div className="mt-4 flex max-w-xs items-center justify-between text-sm text-stone-700" data-x="budgetRow">
                    <span>Rough budget</span>
                    <span className="font-semibold text-stone-900">$150 to $300</span>
                  </div>
                  <div className="mt-4">
                    <span className="btn-primary" data-x="postBtn">Post job</span>
                  </div>
                  <div className={styles.toast} data-x="toast">Your job is live.</div>
                  {/* Notification card: pops with the demo's one ding, right
                      before the homeowner opens Messages. */}
                  <div className={cx("card absolute right-6 top-4 flex items-center gap-3", styles.notif)} data-x="notif">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-hearth-100 text-sm font-semibold text-hearth-700">T</span>
                    <span>
                      <span className="block text-sm font-semibold text-stone-900">Tony R. sent you a quote</span>
                      <span className="block text-xs text-stone-500">Leaking kitchen faucet · replied in 18 min</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* ---------- Messages page (copied from the live app's
                   screenshot: conversation list + thread pane) ---------- */}
              <div className={styles.page} data-page="chatPage">
                <AppNav active={3} />
                <div className="mx-auto max-w-5xl px-6 py-5">
                  <h1 className="text-xl font-semibold text-stone-900">Messages</h1>
                  <div className="mt-3 grid grid-cols-[220px_1fr] gap-4">
                    <div className="card p-0">
                      <div className="border-l-2 border-hearth-500 bg-hearth-50 px-4 py-3">
                        <p className="text-sm font-semibold text-stone-900">Tony R. · Plumbing</p>
                        <p className="text-xs text-stone-500">Sent you a quote</p>
                      </div>
                      <div className="px-4 py-3">
                        <p className="text-sm text-stone-700">
                          Ask Hearth
                        </p>
                        <p className="text-xs text-stone-500">Your home assistant</p>
                      </div>
                    </div>
                    <div className="card" data-x="thread">
                      <p className="text-sm font-semibold text-stone-900">Tony R. · Plumbing · Leaking faucet</p>
                      <div className={cx(styles.thread, "mt-2")}>
                        <span className={cx(styles.bubble, styles.them)} data-x="b1">
                          Hi! I can come Thursday morning. $180 flat, parts included.
                        </span>
                        <span className={cx(styles.bubble, styles.me)} data-x="b2"></span>
                        <span className={styles.wonBadge} data-x="booked">Booked ✓</span>
                        <div className="mt-1 flex items-center gap-2">
                          <div className="input flex flex-1 items-center" data-x="chatInput">
                            <span data-x="typedReply"></span>
                            <span className={styles.caret}>|</span>
                          </div>
                          <span className="btn-primary" data-x="sendBtn">Send</span>
                        </div>
                        <p className="text-xs text-stone-500">
                          Hearth&apos;s cost figures are ballpark estimates. Confirm with a local pro before you commit.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ---------- End card (real site classes) ---------- */}
              <div className={styles.page} data-page="endPage">
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <Logo className="h-12 w-12 text-hearth-700" />
                  <p className="text-2xl font-bold tracking-tight text-stone-900">Hearth</p>
                  <p className="text-sm text-stone-600">Your home, looked after.</p>
                  <p className="mt-1 text-sm text-stone-500">
                    Home health score{" "}
                    <span className="align-middle text-2xl font-bold text-green-700" data-x="endScore">71</span>
                    <span className="align-middle text-sm text-stone-400"> of 100</span>
                  </p>
                  <p className="text-xs text-stone-400">after one season of upkeep</p>
                  {/* A REAL link: the end card is a conversion surface, not a
                      prop. stopPropagation so the click doesn't toggle pause. */}
                  <Link
                    href="/homeowner-signup"
                    className="btn-primary mt-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Get started for free
                  </Link>
                </div>
              </div>

              {/* Cursor + ripple live inside the camera so they zoom with
                  the UI, exactly like a zoomed screen recording. */}
              <span className={styles.cursor} data-x="cursor" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 2 L4 20 L9 15.5 L12.5 22 L15 20.5 L11.5 14 L18 14 Z" fill="#1c1917" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
              </span>
              <span className={styles.ripple} data-x="ripple" aria-hidden="true"></span>
            </div>

            {/* Centered logo card: fades in as the site "loads" after the
                URL is typed, fades out to reveal the dashboard. */}
            <div className={styles.introCard} data-x="intro" aria-hidden="true">
              <Logo className="h-12 w-12 text-hearth-700" />
              <span className={styles.introWord}>Hearth</span>
              <span className={styles.introTag}>Your home, looked after.</span>
            </div>
            <span className={styles.flash} data-x="flash" aria-hidden="true"></span>
          </div>
        </div>
      </div>

      <div className={styles.captionLayer} data-x="captions" aria-hidden="true"></div>

      <div className={styles.bottomGradient}>
        <div className={styles.controlBar}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={started && !finished ? handleTogglePause : handlePlay}
            aria-label={!started || finished ? "Play" : paused ? "Resume" : "Pause"}
          >
            {started && !finished && !paused ? (
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5-13-7.5z" /></svg>
            )}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handleToggleMute}
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="m16 9 5 6M21 9l-5 6" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a9 9 0 0 1 0 12" /></svg>
            )}
          </button>
          <input
            type="range"
            className={styles.volume}
            min={0}
            max={100}
            step={1}
            value={volume}
            onChange={handleVolume}
            aria-label="Volume"
          />
          <div className={styles.seekWrap}>
            <div className={styles.track}><div className={styles.fill} data-x="fill"></div></div>
            <input
              type="range"
              className={styles.seekInput}
              min={0}
              max={1000}
              step={1}
              defaultValue={0}
              data-x="seek"
              onInput={handleSeekPreview}
              onPointerUp={handleSeekCommit}
              onPointerCancel={handleSeekCommit}
              onKeyUp={handleSeekCommit}
              onBlur={handleSeekCommit}
              aria-label="Seek"
            />
          </div>
          <span className={styles.counter} data-x="counter">{fmt(0)} / {fmt(TOTAL_MS)}</span>
          <button
            type="button"
            className={styles.rateBtn}
            onClick={handleCycleRate}
            aria-label={`Playback speed ${RATES[rateIdx]}x, click to change`}
          >
            {RATES[rateIdx]}x
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handleToggleFullscreen}
            aria-label={isFull ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFull ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            )}
          </button>
        </div>
      </div>

      {!started && (
        <button type="button" className={styles.posterOverlay} onClick={handlePlay} aria-label="Play the Hearth demo, about 30 seconds, with sound">
          <span className={styles.posterBg} aria-hidden="true"></span>
          <span className={styles.playCircle} aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4.5v11l9-5.5-9-5.5z" /></svg>
          </span>
          <span className={styles.posterLabel}>From leak to booked pro</span>
          <span className={styles.posterSub}>Watch someone use Hearth, 30 seconds</span>
          <span className={styles.durationBadge}>0:30</span>
        </button>
      )}

      {started && finished && (
        <div className={styles.endOverlay} onClick={(e) => e.stopPropagation()}>
          <Link
            href="/homeowner-signup"
            className="btn-primary"
            onClick={(e) => e.stopPropagation()}
          >
            Get started free
          </Link>
          <button
            type="button"
            className={styles.replayBtn}
            onClick={(e) => {
              e.stopPropagation();
              handlePlay();
            }}
            aria-label="Replay the demo"
          >
            <span className={styles.playCircle} aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10a6 6 0 1 1 2 4.5" /><path d="M4 15v-4h4" /></svg>
            </span>
            <span className={styles.replayLabel}>Watch again</span>
          </button>
        </div>
      )}
    </div>

    {maximized && (
      <button
        type="button"
        className={styles.maxClose}
        onClick={() => setMaximized(false)}
        aria-label="Close maximized view"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    )}
    </div>
  );
}
