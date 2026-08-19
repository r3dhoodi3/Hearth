# Pro Landing Page Demo Video: Transcript and Caption Sync

Source of truth: `src/components/ProDemoPlayer.tsx` (current working tree, Aug 10 re-cut plus the Aug 14 founder notes: dead-air fix, wallet clause cut, new ending line).
Video length: 28.5 seconds (76 beats at 160 BPM, 375 ms per beat).
VO files: `public/demo-vo/pro/*.mp3` (msedge-tts en-US-AvaNeural, rate -8%, 24 kHz 96 kbps CBR mono). `apply.mp3` and `won.mp3` were regenerated on 2026-08-14 with those same settings.

## Full transcript

This is Hearth. Real jobs, from homeowners near you. New jobs post here, with the lead fee shown up front. Apply in one tap. Message the homeowner and line up the visit. Easy as that.

That is the entire spoken track. "Easy as that." is the last line of the video: the on-screen badge still reads "You got the job", but the voice closes on this line per the founder. The end card (beats 71-76) is a silent tag under the music's ring-out, and `end.mp3` is intentionally no longer scheduled.

## Captions timeline

Scene boundaries come from the SCENES beat budgets (hook 13, leads 16, apply 15, chat 18, won 9, end 5). VO start times come from the choreography; VO end times are start plus the measured mp3 duration. Captions mirror each line in 2-word chunks driven off the live audio position, so caption on-screen time equals the VO window below (plus a 250 ms display lead inside the line).

| Scene | Scene window | VO clip | VO start | VO end | Caption text shown |
|---|---|---|---|---|---|
| hook | 00:00.000 - 00:04.875 | hook.mp3 | 00:00.250 | 00:04.786 | This is Hearth. Real jobs, from homeowners near you. |
| leads | 00:04.875 - 00:10.875 | leads.mp3 | 00:04.875 | 00:08.571 | New jobs post here, with the lead fee shown up front. |
| leads (still) | " | apply.mp3 | 00:09.000 | 00:10.800 | Apply in one tap. |
| apply | 00:10.875 - 00:16.500 | (none: its line already played) | - | - | - |
| chat | 00:16.500 - 00:23.250 | chat.mp3 | 00:16.875 | 00:20.139 | Message the homeowner and line up the visit. |
| won | 00:23.250 - 00:26.625 | won.mp3 | 00:24.525 | 00:26.301 | Easy as that. |
| end | 00:26.625 - 00:28.500 | (none, silent tag) | - | - | (no captions) |

Schedule details behind the table:

- hook: `after(250, () => playVo("hook"))` at scene start 0 ms.
- leads: `playVo("leads")` at scene start, beat 13 = 4875 ms.
- apply line: `atBeat(11, () => playVo("apply"))` INSIDE enterLeads, global beat 24 = 9000 ms. This is the Aug 14 dead-air fix: the line used to wait for the apply cut at 10875 ms, leaving ~2.3 s of silence after the leads line; it now starts 429 ms after the leads line ends (inside the requested 400-700 ms breath) and finishes 75 ms before the apply cut. Scene boundaries, beat budgets, TOTAL_BEATS, and the music arrangement are untouched. Nothing in a scene cut stops the VO element (verified: `stopVo` fires only on mute, seek, rate change, scrub, restart, and unmount; only the next `playVo` pauses the current clip), and captions ride with the audio because `captionVo` runs inside `playVo`.
- chat: `atBeat(1, ... playVo("chat"))`, beat 45 = 16875 ms.
- won: `atBeat(3.4, () => playVo("won"))`, beat 65.4 = 24525 ms. The badge and impact hit land on beat 65 (24375 ms, ~86% of runtime); the line starts 150 ms behind the impact.
- Mid-roll CTA chip: beat 56 = 21000 ms.
- Caption chunking (2 words per chunk, even time split of the clip): hook 5 chunks at 907 ms, leads 6 at 616 ms, apply 2 at 900 ms, chat 4 at 816 ms, won 2 at 888 ms ("Easy as" / "that.").

## Aug 14 changes (founder notes)

1. Dead air at 8-11 s removed: the apply VO line moved from the apply cut (10875 ms) to global beat 24 (9000 ms), scheduled from enterLeads. Gap after the leads line is now 429 ms.
2. Wallet mention removed: the apply line was "Apply in one tap. The fee comes from your wallet." and is now "Apply in one tap." (wallet clause dropped, no new copy). The wallet tick-down (80 -> 30), toast, and fee chip stay on screen, unnarrated.
3. Ending line changed: the won clip was "You got the job." and is now "Easy as that." The on-screen badge keeps "You got the job ✓".

Audio regeneration: no generator script exists in the repo (it lived in a previous session's scratchpad), but the component documents the exact settings, so `apply.mp3` and `won.mp3` were regenerated with a one-off Node script using the `msedge-tts` npm package (v2.0.7, no API key needed): voice en-US-AvaNeural, rate -8%, output format 24 kHz 96 kbps mono MP3. A frame-walk of the new files confirms the identical codec profile to the untouched clips (MPEG-2 Layer III, 24 kHz, 96 kbps CBR, no ID3). The other four mp3s are byte-identical to before.

## Sync verification

Method: no ffprobe on this machine, so real durations were measured by walking every MPEG frame header in each file with a small Node script (ID3-aware, sums samples-per-frame / sample-rate per frame). All files are clean CBR 96 kbps with no tags, so the frame walk is exact and also matches the bytes / 12000 convention noted in the component.

Measured durations vs the component's hardcoded `VO_EST_MS` map:

| Clip | Real duration | VO_EST_MS | Diff | Verdict |
|---|---|---|---|---|
| hook.mp3 | 4536 ms | 4540 | 4 ms | OK |
| leads.mp3 | 3696 ms | 3700 | 4 ms | OK |
| apply.mp3 (new) | 1800 ms | 1800 | 0 ms | OK (map updated with the regen) |
| chat.mp3 | 3264 ms | 3260 | 4 ms | OK |
| won.mp3 (new) | 1776 ms | 1780 | 4 ms | OK (new line happens to match the old clip's duration) |
| end.mp3 | 5424 ms | (not in map) | - | Expected: intentionally unscheduled |

Every value is within 4 ms of the real file, far inside the 150 ms drift threshold. The estimates only matter for the muted fallback and pre-load seeks anyway; the unmuted path reads the audio element's true duration and drives chunks off `a.currentTime`, which cannot drift.

Window fits (clip end vs the next thing that would cut it off):

| Clip | Ends at | Hard limit | Headroom | Verdict |
|---|---|---|---|---|
| hook | 4786 ms | 4875 ms (leads VO starts, playVo stops the current clip) | 89 ms | Fits |
| leads | 8571 ms | 9000 ms (apply VO starts) | 429 ms | Fits |
| apply | 10800 ms | 16875 ms (chat VO starts; the 10875 ms scene cut does not stop VO) | 6075 ms | Fits |
| chat | 20139 ms | 23250 ms (scene end) | 3111 ms | Fits |
| won | 26301 ms | 26625 ms (end card arrives) | 324 ms | Fits |

Re-cut math, checked specifically:

- won is 9 beats = 3375 ms. The VO starts 1275 ms into the scene (beat 3.4) and runs 1776 ms, ending 324 ms before the end card cut. "Easy as that." fits the 9-beat scene exactly as the old line did.
- The final caption chunk ("that.") clears when the audio ends at ~26.30 s, before the end card at 26.625 s. The muted fallback clears even in the worst case at 24525 + 90 + 1780 + 150 = 26545 ms, still before the cut.
- Files on disk vs schedule: all five scheduled clips exist; `end.mp3` exists but is never scheduled, which is the intended Aug 10 re-cut behavior (it is not even preloaded, since `VO_TEXT` has no `end` key), not a bug.

## Remaining inter-line VO gaps (report only, unchanged by design)

| Gap | From | To | Size | Covered by on-screen action? |
|---|---|---|---|---|
| hook to leads | 4786 ms | 4875 ms | 89 ms | Natural breath at the scene cut. |
| leads to apply | 8571 ms | 9000 ms | 429 ms | The fixed one: now a natural breath while the hand rests on the fee chip. |
| apply to chat | 10800 ms | 16875 ms | 6075 ms | Yes, densest stretch of the video: apply click (~11.9 s), "Draft it for me" click and AI note reveal with coin ding (~12.6-13.0 s), confirm-and-pay at ~13.95 s with the wallet counting 80 -> 30 plus toast, wallet pop zoom at 15.0 s, unread badge at 15.45 s, Messages tab click at 15.6 s, whoosh page cut at 16.5 s. Grew from 2088 ms because the wallet clause was cut; the action carries it. |
| chat to won | 20139 ms | 24525 ms | 4386 ms | Yes: the pro types the 31-character reply (keyboard SFX), send click, a beat of quiet, the typing indicator, the "Perfect, you're hired" bubble, then the riser builds from beat 60 (22.5 s) into the badge drop and impact at 24.375 s. |

Result: no sync bugs; all clips fit their windows after the changes. `npx tsc --noEmit` passes on the edited component.
