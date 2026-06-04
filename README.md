<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Everywhere-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/Vite-8-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind" />
  <img src="https://img.shields.io/badge/WebSocket-Multiplayer-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSocket" />
  <img src="https://img.shields.io/badge/Canvas-2D-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="Canvas" />
</p>

<h1 align="center">Zeriel</h1>
<p align="center"><strong>Live Imperfect Karaoke — a real-time multiplayer browser party game</strong></p>

<p align="center">
  A song plays. Its time-synced lyrics fall from the top of the screen as physics-driven <em>rope-letters</em> that tumble, bounce, and pile up. Everyone in a shared room grabs words with their cursor and drags them into the correct order before the next line drops. At the end you get a shareable scorecard image.
</p>

<p align="center">
  No account. No install. Just open a link and play.
</p>

---

## Table of Contents

- [How It Works](#how-it-works)
- [The Aesthetic](#the-aesthetic)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Deployment (VPS)](#deployment-vps)
- [Testing](#testing)
- [How a Round Plays Out](#how-a-round-plays-out)
- [Design Decisions](#design-decisions)
- [License](#license)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Client)                                               │
│                                                                 │
│  React UI Shell ─┬─ Landing Page (scroll-reveal, premium dark)  │
│                  ├─ Lobby (song picker, resolve audio + lyrics) │
│                  ├─ Round Canvas (physics + handmade aesthetic)  │
│                  └─ Scorecard (export shareable image)           │
│                                                                 │
│  GameCore (prediction) ← identical code to server               │
│  Renderer (Canvas 2D) ← 60fps interpolated from 30Hz physics   │
│  Audio_Player (Web Audio API) ← AnalyserNode reactive visuals   │
│  Net Client ← WebSocket, clock sync, reconciliation             │
└──────────────────────────────┬──────────────────────────────────┘
                               │ WebSocket (JSON)
┌──────────────────────────────▼──────────────────────────────────┐
│  Game Server (Node.js)                                          │
│                                                                 │
│  Authoritative GameCore (30Hz tick) ← source of truth           │
│  Room Manager ← join/leave, locks, reconnection                 │
│  State Broadcaster (≥15Hz) ← snapshots to all clients           │
└─────────────────────────────────────────────────────────────────┘
```

## The Aesthetic

Two deliberately opposite visual modes:

| Surface | Look | Why |
|---------|------|-----|
| **Before the round** (landing, lobby, song picker) | Clean, dark, polished — Spotify-style premium feel | Sets expectations, builds anticipation |
| **During the round** (play area) | Intentionally rough — VHS colors, scan-lines, ransom-note cut-out letters, paper grain, off-grid placement | The chaos IS the aesthetic; controls stay tight |

The trick: even though it *looks* messy and handmade, the controls are responsive and the physics are precise. The chaos is cosmetic, not mechanical.

## Architecture

### Three load-bearing decisions

1. **One shared `GameCore` runs all gameplay logic.** Physics, ownership locks, ordering, and scoring live in a single pure, dependency-free module. That same module runs in the browser for single-player and on the server for multiplayer — so both modes behave identically by construction.

2. **The server is authoritative; the client predicts and reconciles.** The server runs a fixed ~30Hz physics tick that owns ground-truth letter positions. The browser predicts your own movements instantly, then quietly reconciles to whatever the server says.

3. **Single-player ships first; multiplayer layers on top.** The game is fully playable solo before any networking exists. Multiplayer just adds room presence, shared cursors, and ownership locks. The game still demos even if the server is down.

### Physics engine

Each letter is a chain of Verlet particles connected by distance constraints (a "rope"). That's why letters droop, swing when yanked, bounce off walls, and pile up instead of passing through each other.

```
Verlet integration:  x_next = x + damping * (x - prev) + acceleration * dt²
Constraint solver:   iterative relaxation (8 passes per tick)
Collision:           positional push with inverse-mass weighting
Bounds:              reflect + damp at play-area edges
```

### Networking model

```
Client → Server:  cursor (≥15/s), grab, release, startRound
Server → Client:  welcome, roster, snapshot (≥15Hz), grabResult, roundState

Prediction:  grab locally IFF the letter isn't visibly locked by another player
Reconcile:   on each snapshot, overwrite authority, re-apply still-pending inputs
Clock sync:  median-offset handshake on connection (align physics timelines)
```

## Tech Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Build / App Shell | Vite + React + TypeScript | Fast iteration; React owns only top-level UI state |
| Styling | Tailwind CSS 4 | Rapid premium-surface layout; gameplay is raw Canvas |
| Gameplay Rendering | 2D HTML5 Canvas | Direct pixel control for ransom-note letters, scan-lines |
| Physics | Custom Verlet engine (`@glitch/core`) | Shared client/server; no external physics dependency |
| Realtime Transport | Node.js WebSocket (`ws`) | Full-duplex, sub-100ms, authoritative 30Hz tick |
| Audio | Web Audio API | Streams resolved URLs; AnalyserNode for reactive visuals |
| Audio Source | yt-dlp → @distube/ytdl-core → Piped/Invidious | Multi-layer fallback, server-proxied CORS-clean |
| Lyrics | LRCLIB | Free, no-auth, returns time-synced LRC format |
| Scroll Animations | GSAP + ScrollTrigger | React Bits ScrollReveal on premium surfaces |
| Scorecard Export | Canvas `toBlob` | Render to canvas, export as shareable PNG |
| Testing | Vitest + fast-check | 487 tests (unit + property-based, 100 generated cases) |

## Project Structure

```
zeriel/
├── core/                     # Pure, dependency-free GameCore
│   └── src/
│       ├── gameCore/         # Physics tick, ownership, scoring, snapshots
│       ├── physics/          # Verlet integration, constraints, bounds, collision
│       ├── round/            # Round lifecycle state machine
│       ├── scheduler/        # Time-synced lyric dropper
│       └── types/            # Shared type definitions
├── client/                   # Browser app (Vite + React)
│   └── src/
│       ├── audio/            # Web Audio player + stall watchdog
│       ├── host/             # LocalGameHost / RemoteGameHost (host abstraction)
│       ├── net/              # NetClient, protocol, prediction, reconciliation
│       ├── render/           # Canvas 2D renderer (handmade aesthetic)
│       ├── rooms/            # Join-link build/parse
│       ├── scorecard/        # Scorecard render + image export
│       ├── scrollReveal/     # GSAP ScrollTrigger word-by-word reveal
│       ├── server/           # Server-side music proxy + production server
│       ├── services/         # Audio resolver, lyrics service, error mapping
│       ├── shell/            # React UI surfaces (landing, lobby, round, scorecard)
│       ├── songPicker/       # Song search controller + backend
│       └── theme/            # Reduce-motion + theme selection
├── server/                   # Multiplayer Game Server (Node + ws)
│   └── src/
│       ├── game/             # GameRoom (authoritative tick), broadcast, tick plan
│       ├── net/              # GameServer orchestrator, ws adapter, protocol
│       └── rooms/            # RoomManager (identity, locks, reconnection)
├── .kiro/specs/              # Requirements, design, and implementation plan
├── package.json              # Workspace root (npm workspaces)
├── vitest.config.ts          # Monorepo test config
└── tsconfig.base.json        # Strict shared TypeScript config
```

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **yt-dlp** on PATH (for full-track audio; install via `winget install yt-dlp` / `apt install yt-dlp`)
- **ffmpeg** on PATH (optional; used by yt-dlp for some formats)

### Install & Run (Development)

```bash
# Clone
git clone https://github.com/your-username/zeriel.git
cd zeriel

# Install all workspace dependencies
npm install

# Start the client dev server (includes music proxy middleware)
npm run dev

# Open http://localhost:5173 — search for a song and play!
```

### Other commands

```bash
npm run dev:server     # Start the multiplayer WebSocket server (optional)
npm test               # Run all 487 tests (unit + property-based)
npm run typecheck      # TypeScript strict check across all workspaces
npm run build          # Production build (server + client)
```

## Configuration

Create a `.env` file at the workspace root (see [`.env.example`](./.env.example)):

| Variable | Purpose | Default |
|----------|---------|---------|
| `YOUTUBE_API_KEY` | Reliable song search via YouTube Data API v3 | *(unset → falls back to Piped search)* |
| `PORT` | Production server port | `8080` |
| `HOST` | Production server bind address | `0.0.0.0` |
| `YTDLP_PATH` | Path to the `yt-dlp` binary | `yt-dlp` *(on PATH)* |
| `YTDLP_DISABLE` | Set to `1` to skip the yt-dlp backend | *(enabled)* |

All keys are read **server-side only** and are never exposed to the browser bundle.

## Deployment (VPS)

```bash
# 1. System dependencies
sudo apt update && sudo apt install -y yt-dlp ffmpeg

# 2. Clone and build
git clone https://github.com/your-username/zeriel.git
cd zeriel
npm install
npm run build

# 3. Configure
cp .env.example .env
# Edit .env: set YOUTUBE_API_KEY for reliable search

# 4. Start the production server
#    Serves the built client at / and the music proxy at /api/music/*
PORT=8080 npm start --workspace @glitch/client

# 5. (Optional) Start the multiplayer WebSocket server
HOST=0.0.0.0 PORT=8081 npm run dev:server
```

### Reverse proxy (recommended)

Put the production server behind nginx or Caddy with TLS:

```nginx
server {
    listen 443 ssl;
    server_name zeriel.yoursite.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Testing

The project uses **Vitest** with **fast-check** for property-based testing:

```bash
npm test              # 487 tests across 76 files
npm test -- --watch   # Watch mode
```

### Test categories

| Category | Count | What's tested |
|----------|-------|---------------|
| Property-based (fast-check) | ~200 | Physics invariants, scoring conservation, reconciliation safety |
| Unit tests | ~250 | GameCore, services, protocol, error mapping, scheduler |
| Integration tests | ~30 | Audio resolution, round lifecycle, proxy validation |

Every property test runs **100 generated cases** by default (configurable globally). GameCore and the physics engine take an explicit seed, so failures are reproducible and shrinkable.

### Key correctness properties

- Constraint rest lengths are preserved within tolerance after resolution
- Particles never leave the play-area bounds
- Letters do not pass through each other
- Ownership locks are exclusive and properly released on disconnect
- Scoring equals the count of correctly ordered letters
- Per-player contributions conserve the total score
- Snapshot round-trip reproduces authoritative state
- Clock-offset estimation aligns timelines
- Reconciliation makes the client match authoritative state

## How a Round Plays Out

1. **Host searches** for a song via the Song Picker (YouTube Data API or Piped).
2. **Audio resolves** server-side (yt-dlp → @distube → Piped), proxied same-origin.
3. **Lyrics fetch** from LRCLIB (time-synced LRC format, ±2s duration match).
4. **Song plays.** Lyric lines drop in, word by word, in time with the music.
5. **Players grab** words and drag them into the correct order. Only one person can hold a given piece at a time.
6. **Round ends.** Group score + per-player contributions → shareable scorecard image.

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Pure `GameCore` with zero dependencies | Single-player/multiplayer equivalence by construction; trivially property-testable |
| Verlet physics (not Euler) | Stable under sudden velocity changes; letters don't "explode" when yanked |
| Seeded PRNG for spawn jitter | Deterministic; identical seed + inputs = identical state (client/server agreement) |
| Client predicts grabs, server reconciles | <50ms local response; correctness guaranteed by authority |
| yt-dlp subprocess as primary audio | Most actively maintained YouTube extractor; adapts to changes within hours |
| Server-proxied audio (same-origin) | CORS-clean for Web Audio AnalyserNode; reactive visuals stay alive |
| Fixed 30Hz physics / 60fps render | Physics decoupled from display; interpolation keeps rendering smooth |
| No accounts, no install | Link-based join; Room_Code-gated access; session-scoped identity |
| Scorecard as a first-class feature | The thing people screenshot and share — the growth mechanism |

## Audio Resolution Chain

```
┌──────────────────────────────────────────────────────────────┐
│  Client selects a track (YouTube video ID from search)       │
│                          │                                    │
│                          ▼                                    │
│  GET /api/music/audio?id=VIDEO_ID                            │
│                          │                                    │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │  Server-side resolution (musicProxy.ts)                │  │
│  │                                                        │  │
│  │  1. yt-dlp --get-url (PRIMARY, 20s timeout)            │  │
│  │     └─ Spawns subprocess, no shell, validated id       │  │
│  │                                                        │  │
│  │  2. @distube/ytdl-core (JS FALLBACK)                   │  │
│  │     └─ In-process, no binary dependency                │  │
│  │                                                        │  │
│  │  3. Piped + Invidious instances (LAST DITCH)           │  │
│  │     └─ Promise.any across public endpoints             │  │
│  │                                                        │  │
│  │  Result cached 5min (googlevideo URLs are short-lived) │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                   │
│                           ▼                                   │
│  Proxy bytes to browser (Range support, abort on disconnect) │
│  → <audio crossorigin="anonymous"> → AnalyserNode → visuals  │
└──────────────────────────────────────────────────────────────┘
```

## Performance

- **60fps rendering** even with 30Hz physics (interpolation between states)
- **Zero per-frame allocation** in physics loops and renderer (pre-allocated vectors/buffers)
- **Off-screen canvas buffering** for static textures (paper grain, scan-lines rendered once)
- **Fixed-timestep accumulator** prevents physics from coupling to display refresh rate
- **Sub-stepping** available for fast-drag stability (configurable constraint iterations)

## Accessibility

- **Reduce-motion mode** — respects `prefers-reduced-motion`, persists explicit choice, suppresses non-essential animation while preserving gameplay
- **4.5:1 contrast ratio** on body text
- **Semantic HTML** headings and labeled controls outside the Canvas
- **ARIA** live regions for status updates (resolving, errors, ready state)

---

<p align="center">
  Built by a solo developer with AI assistance.<br/>
  <em>The chaos is the aesthetic, not the gameplay.</em>
</p>
