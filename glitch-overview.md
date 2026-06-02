# Zeriel — Live Imperfect Karaoke

## What it is

Zeriel is a free, open-source, real-time multiplayer browser party game. Think
"karaoke meets a chaotic word puzzle."

A song plays, and its time-synced lyrics fall from the top of the screen as
physics-driven **rope-letters** that tumble, bounce, and pile up. Everyone in a
shared room grabs different words or letters with their cursor and drags them
into the correct order before the next lyric line drops. At the end you get a
shareable scorecard image.

The whole thing runs in the browser. No account, no install — you just open a
link and play.

## The vibe

There are two deliberately opposite looks:

- **Before the round** (landing page, lobby, song picker): clean, dark, polished,
  Spotify-style premium feel.
- **During the round** (the actual play area): intentionally rough and
  "broken-looking" — VHS colors, scan-lines, ransom-note cut-out letters, paper
  grain, things sitting slightly off-grid.

The trick is that even though it *looks* messy and handmade, the actual controls
stay tight and responsive. The chaos is the aesthetic, not the gameplay.

## How a round plays out

1. The host searches for a song and picks it.
2. The game fetches the audio and the time-synced lyrics.
3. The song plays. Lyric lines drop in, letter by letter, in time with the music.
4. Players grab letters/words and drag them into the right order. Only one person
   can hold a given piece at a time (no fighting over the same letter).
5. When the song ends, you get a group score plus who contributed what — exported
   as an image you can share.

## How it's built (the technical bit)

Stack: **TypeScript** everywhere — Vite + React + Tailwind on the front end, a
Node WebSocket server on the back end, HTML5 Canvas for the gameplay rendering,
and the Web Audio API for sound.

Three big design decisions hold the whole thing together:

1. **One shared "game core" runs all the gameplay logic.** Physics, ownership of
   letters, ordering, and scoring all live in a single pure, dependency-free
   module. That same module runs in the browser for single-player and on the
   server for multiplayer — so both modes behave identically by construction.

2. **The server is the source of truth; the client predicts and corrects.** The
   server runs a fixed ~30 times-per-second physics tick that owns the real
   letter positions. Your browser predicts your own movements instantly so it
   feels responsive, then quietly reconciles to whatever the server says.

3. **Single-player ships first; multiplayer is layered on top.** The game is fully
   playable solo before any networking exists. Multiplayer just adds room
   presence, shared cursors, and "who's holding what" locks on top. This means
   the game still demos even if multiplayer runs out of time.

### The physics

Each letter is a little chain of particles connected by springs (a "Verlet" rope).
That's why letters droop, swing when you yank them, bounce off the walls, and pile
on top of each other instead of passing through.

### Where the music and lyrics come from

- **Audio:** resolved through the Piped API (a privacy-friendly YouTube frontend),
  with automatic fallback across multiple servers so it loads reliably.
- **Lyrics:** time-synced lyrics pulled from LRCLIB, parsed so each line drops at
  exactly the right moment.

Every external request has an 8-second timeout and a clear "here's what went wrong,
here's what to do next" error, so nothing ever silently breaks.

## Nice touches

- **Accessibility:** a reduce-motion mode that calms the visual chaos (and respects
  your browser setting), readable contrast, proper headings and labels.
- **Performance target:** smooth 60fps rendering even though physics runs at 30Hz,
  with no per-frame memory churn.
- **Scroll-reveal animations** on the landing page for that premium entry feel.
- **The scorecard is a real feature, not an afterthought** — it's the thing people
  screenshot and share, which is how the game spreads.

## Scope & timeline

Built by a solo developer with AI assistance on roughly a two-week timeline. The
work is structured so the riskiest, highest-value piece (a fun single-player round)
is solid first, and everything else stacks on top.
