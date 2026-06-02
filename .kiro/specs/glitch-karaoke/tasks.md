# Implementation Plan: Glitch (Live Imperfect Karaoke)

## Overview

This plan builds Glitch incrementally in TypeScript (Vite + React + TypeScript, Tailwind, Vitest + fast-check, Node `ws` server) following the design's load-bearing decision: a single pure, deterministic `GameCore` module is the source of all gameplay logic, single-player is built and shippable first, and multiplayer is layered on top as a thin networking concern.

The build order is: foundations and types → shared request discipline and external service clients → pure physics → `GameCore` (spawning, locks, scoring, snapshots) → lyric scheduling and round lifecycle → audio, rendering, UI surfaces → single-player end-to-end → authoritative server → networking, prediction, and reconciliation → multiplayer wiring and mode-equivalence verification. Each step ends by wiring into the prior steps so no code is orphaned.

Property-based tests (one per design property, marked optional with `*`) are placed immediately after the code they validate. `GameCore` and the other pure modules take an explicit seed so failures are reproducible and shrinkable.

## Tasks

- [x] 1. Project setup and shared data models
  - [x] 1.1 Scaffold the workspace and toolchain
    - Initialize a Vite + React + TypeScript app and a Node server package that share a `core` module directory
    - Add Tailwind CSS for premium surfaces, `ws` for the WebSocket server, `gsap` with the ScrollTrigger plugin, and Vitest + `fast-check` for testing
    - Configure Vitest to run property tests with `{ numRuns: 100 }` as the default, and add a test script using `vitest --run`
    - _Requirements: 19.7_

  - [x] 1.2 Define core shared types and data models
    - Create the shared types module with `Vec2`, `Particle`, `Constraint`, `RopeLetter`, `LyricLine`, `SolutionSlot`, `LineScore`, `RoundResult`, `Room`, `Player`, `RoundState`, `Snapshot`, `TrackCandidate`, `TrackSignature`, `RenderOptions`, and `ScrollRevealConfig`
    - Define the `GameCore` public surface (`spawnLine`, `applyInput`, `tick`, `snapshot`, `applySnapshot`, `getRoundResult`) and the `PlayerInput` / `InputOutcome` types as the contract for later steps
    - _Requirements: 2.1, 2.2, 9.1, 9.5, 9.6, 16.3_

- [x] 2. Shared request discipline and external service clients
  - [x] 2.1 Implement the shared `fetchWithTimeout` helper
    - Wrap `fetch` with an `AbortController` capped at 8000ms; abort and return a typed failure when the cap is exceeded
    - _Requirements: 17.2_

  - [x]* 2.2 Write property test for request timeout discipline
    - **Property 40: External requests fail past the timeout**
    - **Validates: Requirements 17.2**

  - [x] 2.3 Implement the Audio_Resolver with Piped multi-instance fallback
    - Iterate the configured ordered Piped instances, requesting `GET {instance}/streams/{videoId}` via `fetchWithTimeout`, attempting each instance at most once per resolution
    - Treat error, timeout, or empty `audioStreams` as a per-instance failure and advance; return the first usable highest-bitrate `videoOnly === false` URL plus the forwarded `duration`; report `all_instances_failed` when every instance fails
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x]* 2.4 Write property test for Piped fallback resolution outcome
    - **Property 11: Piped fallback returns the first usable URL or fails after exhausting instances**
    - **Validates: Requirements 4.2, 4.4, 4.5**

  - [x]* 2.5 Write property test for single-attempt-per-instance discipline
    - **Property 12: Each Piped instance is attempted at most once per resolution**
    - **Validates: Requirements 4.3**

  - [x] 2.6 Implement the Lyrics_Service and LRC parser
    - Build the `GET {LRCLIB}/api/get` request encoding the track signature (track, artist, album, duration) via `fetchWithTimeout`, with a `GET /api/search?q=` fallback for loose matches
    - Parse `syncedLyrics` LRC text into ordered `LyricLine`s (timestamp → ms + text), dropping malformed/empty lines and sorting by ascending start time; classify 404/null as `no_lyrics` (allowing lyrics-free listening or a different track) and error/timeout as `retrieval_failed`
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 17.3_

  - [x]* 2.7 Write property test for LRCLIB signature encoding
    - **Property 14: LRCLIB request encodes the track signature**
    - **Validates: Requirements 6.1**

  - [x]* 2.8 Write property test for LRC parse round trip and ordering
    - **Property 15: LRC parse round trip and ordering**
    - **Validates: Requirements 6.2**

  - [x] 2.9 Implement the external-error-to-message mapping
    - Map each typed failure result (Piped, LRCLIB, search) to a non-empty actionable message plus next-step actions, including a retry action for recoverable errors
    - _Requirements: 17.1, 17.5_

  - [x]* 2.10 Write property test for actionable error mapping
    - **Property 39: External errors map to actionable, retryable messages**
    - **Validates: Requirements 17.1, 17.5**

  - [x]* 2.11 Write unit tests for service error branches
    - Cover the no-lyrics branch, lyrics-retrieval-failure retry state, and the audio-resolution-failure "pick a different track" branch
    - _Requirements: 6.4, 6.5, 4.5, 4.6_

- [x] 3. Verlet physics primitives
  - [x] 3.1 Implement Verlet integration and distance constraints
    - Integrate particles with implicit velocity (`x - prev`), damping, and gravity; resolve distance constraints over the configured relaxation iterations, honoring pinned (infinite-mass) particles and stiffness
    - Reuse pre-allocated `Vec2` scratch objects inside the loops rather than allocating per step
    - _Requirements: 7.2, 7.3, 14.2, 14.3_

  - [x]* 3.2 Write property test for constraint preservation
    - **Property 18: Constraint rest lengths are preserved within tolerance**
    - **Validates: Requirements 7.3**

  - [x] 3.3 Implement boundary clamping and inter-letter stacking
    - Clamp particles to the play-area rectangle with reflection and damped `prev` adjustment; resolve overlapping collider nodes positionally so letters pile rather than penetrate
    - _Requirements: 7.4, 7.5_

  - [x]* 3.4 Write property test for play-area bounds
    - **Property 19: Particles remain within play-area bounds**
    - **Validates: Requirements 7.4**

  - [x]* 3.5 Write property test for non-penetration
    - **Property 20: Letters do not pass through each other**
    - **Validates: Requirements 7.5**

- [x] 4. GameCore: spawning, ownership locks, scoring, snapshots
  - [x] 4.1 Implement `spawnLine` and Solution_Slot generation
    - Spawn exactly one `RopeLetter` per letter/word token within the top spawn band using a seeded PRNG for deterministic ransom-note jitter; build the `0..n-1` Solution_Slot sequence aligned to the correct order
    - _Requirements: 7.1, 9.1, 12.1_

  - [x]* 4.2 Write property test for per-token spawning
    - **Property 17: One rope-letter spawned per token at the top of the play area**
    - **Validates: Requirements 7.1**

  - [x]* 4.3 Write property test for solution-slot ordering
    - **Property 25: Solution-slot sequence matches the correct order**
    - **Validates: Requirements 9.1**

  - [x] 4.4 Implement ownership-lock handling and held-letter movement
    - Process `grab`/`release`/`cursor` inputs in `applyInput`: assign a lock on an unlocked letter, deny a grab on a letter locked by another player, clear the lock on release; pin and steer a held letter's grabbed node toward its owner's cursor each tick
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x]* 4.5 Write property test for lock lifecycle and exclusivity
    - **Property 21: Ownership-lock lifecycle and exclusivity**
    - **Validates: Requirements 8.1, 8.2, 8.4**

  - [x]* 4.6 Write property test for held-letter cursor tracking
    - **Property 22: A held letter moves toward its owner's cursor**
    - **Validates: Requirements 8.3**

  - [x] 4.7 Implement placement marking and scoring
    - Mark a resting letter as placed in a Solution_Slot only within its tolerance (else null); maintain provisional per-line score during the drop window, finalize at window close as the count of correctly-ordered letters, accumulate the Round total, and credit per-Player contributions
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x]* 4.8 Write property test for tolerance-based placement
    - **Property 26: Placement marking respects tolerance**
    - **Validates: Requirements 9.2**

  - [x]* 4.9 Write property test for score correctness
    - **Property 27: Score equals the count of correctly ordered letters**
    - **Validates: Requirements 9.3, 9.4**

  - [x]* 4.10 Write property test for round-total summation
    - **Property 28: Round total is the sum of finalized line scores**
    - **Validates: Requirements 9.5**

  - [x]* 4.11 Write property test for contribution conservation
    - **Property 29: Per-player contributions conserve the total**
    - **Validates: Requirements 9.6**

  - [x] 4.12 Implement the deterministic tick sequence and snapshot round trip
    - Run the fixed step order (apply inputs/locks → steer held letters → integrate → relax constraints → bounds then overlap → evaluate placement/scores); implement `snapshot()` and `applySnapshot()` over letters, locks, cursors, and scores
    - _Requirements: 7.6, 16.1, 16.3_

  - [x]* 4.13 Write property test for snapshot reproduction
    - **Property 37: Snapshot round trip reproduces authoritative state**
    - **Validates: Requirements 16.3**

- [x] 5. Checkpoint - GameCore core
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Lyric scheduling and round lifecycle
  - [x] 6.1 Implement the lyric scheduler
    - Drop each Lyric_Line exactly once at its start timestamp relative to monotonic playback time, never before its timestamp and in ascending order, feeding `GameCore.spawnLine`
    - _Requirements: 6.3, 10.2_

  - [-]* 6.2 Write property test for lyric scheduling
    - **Property 16: Lyric scheduling drops each line once, in order, at its timestamp**
    - **Validates: Requirements 6.3, 10.2**

  - [-] 6.3 Implement the Round state machine
    - Implement `lobby → resolving → ready/resolve_failed → playing → scoring` with `playing` reachable only from `ready`, start rejected as not-ready otherwise, scored-start prevented when audio is unresolved, and full finalization of the Round result before notifying clients to show the Scorecard
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 17.4_

  - [ ]* 6.4 Write property test for readiness-gated start
    - **Property 32: Round start is gated on readiness**
    - **Validates: Requirements 10.5**

  - [ ]* 6.5 Write property test for scored-round audio requirement
    - **Property 41: Scored rounds require resolved audio**
    - **Validates: Requirements 17.4**

  - [ ]* 6.6 Write property test for finalize-before-scorecard
    - **Property 31: Results are fully finalized before the scorecard is shown**
    - **Validates: Requirements 10.4**

- [x] 7. Audio_Player (Web Audio)
  - [x] 7.1 Implement the Audio_Player
    - Wire `<audio crossorigin="anonymous">` → `MediaElementAudioSourceNode` → `AnalyserNode` → destination; expose playback time, per-frame amplitude (RMS) and frequency bins into pre-allocated buffers, play from track start, and run a stall watchdog that reports failure after >5s without progress
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 7.2 Write property test for stall detection
    - **Property 13: Playback stall detection**
    - **Validates: Requirements 5.4**

  - [ ]* 7.3 Write integration test for Web Audio wiring and analysis
    - Verify the node graph loads a stream and exposes amplitude/frequency and playback time using a representative case
    - _Requirements: 5.1, 5.3, 5.5_

- [x] 8. Reduce-motion and theme selection
  - [x] 8.1 Implement reduce-motion resolution and theme selection
    - Resolve the effective Reduce_Motion_Mode as the stored explicit choice when present, otherwise the browser `prefers-reduced-motion` setting; persist explicit choices; implement a theme selector that returns the handmade gameplay theme for the in-round play area and never the premium theme for that surface
    - _Requirements: 13.2, 13.3, 18.3, 18.4_

  - [x]* 8.2 Write property test for explicit reduce-motion precedence
    - **Property 36: Explicit reduce-motion choice takes precedence**
    - **Validates: Requirements 13.3**

  - [x]* 8.3 Write property test for theme separation
    - **Property 42: Theme separation between premium and gameplay surfaces**
    - **Validates: Requirements 18.3, 18.4**

- [x] 9. Renderer (Canvas 2D handmade aesthetic)
  - [x] 9.1 Implement the Renderer
    - Pre-render paper-grain and scan-line textures to off-screen buffers once at init and stamp them per frame; draw ransom-note glyphs with per-letter rotation/placement variation, bounded off-grid offsets, and neo-brutalist borders; interpolate between physics states by `alpha`; react to the audio frame; suppress scan-line jitter and decorative shake under Reduce_Motion_Mode while preserving gameplay motion
    - _Requirements: 5.3, 12.1, 12.2, 12.3, 12.4, 12.5, 13.1, 14.1_

  - [-]* 9.2 Write property test for bounded off-grid offsets
    - **Property 34: Off-grid offsets are bounded**
    - **Validates: Requirements 12.3**

  - [-]* 9.3 Write property test for reduce-motion suppression
    - **Property 35: Reduce-motion suppresses decoration but preserves gameplay**
    - **Validates: Requirements 13.1**

  - [-]* 9.4 Write snapshot/static-audit tests for art direction
    - Audit ransom-note/scan-line/paper-grain/neo-brutalist rendering paths
    - _Requirements: 12.1, 12.2, 12.4, 12.5_

- [x] 10. Song_Picker (premium entry surface)
  - [x] 10.1 Implement the Song_Picker component
    - Search the backend through `fetchWithTimeout`, list candidates with title + artist, record the selected candidate as the pending track, show a loading indicator and block resubmission while a search is in flight, and gate control to the single player in SP or the Host in MP, using its own art direction with no Spotify branding
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 18.5_

  - [x]* 10.2 Write property test for candidate fields
    - **Property 7: Search candidates expose title and artist**
    - **Validates: Requirements 3.1**

  - [x]* 10.3 Write property test for pending-track selection
    - **Property 8: Selection records the pending track**
    - **Validates: Requirements 3.2**

  - [x]* 10.4 Write property test for single in-flight search
    - **Property 9: At most one search is in flight**
    - **Validates: Requirements 3.5**

  - [x]* 10.5 Write property test for control authorization
    - **Property 10: Song-picker control authorization**
    - **Validates: Requirements 3.6**

  - [x]* 10.6 Write unit test for empty search results
    - Cover the "no results" message and post-completion re-query gating
    - _Requirements: 3.4_

- [x] 11. ScrollReveal component
  - [x] 11.1 Implement the ScrollReveal component
    - Split a string child into one `<span>` per word; scrub per-word opacity and blur and container rotation against scroll progress via GSAP ScrollTrigger between configured base values (progress 0) and fully revealed (progress 1); expose `enableBlur`, `baseOpacity`, `baseRotation`, `blurStrength`, `scrollStart`, `scrollEnd`; render fully revealed under Reduce_Motion_Mode; restrict usage to non-gameplay surfaces; kill its ScrollTrigger instances on unmount
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.8_

  - [x]* 11.2 Write property test for lossless word splitting
    - **Property 43: ScrollReveal word splitting is lossless**
    - **Validates: Requirements 19.1**

  - [x]* 11.3 Write property test for scroll-progress mapping
    - **Property 44: Scroll-progress mapping is monotonic and honors configured endpoints**
    - **Validates: Requirements 19.2, 19.5**

  - [x]* 11.4 Write property test for reduce-motion reveal
    - **Property 45: Reduce-motion fully reveals the text**
    - **Validates: Requirements 19.6**

  - [x]* 11.5 Write property test for ScrollTrigger cleanup
    - **Property 46: ScrollTrigger instances are cleaned up on unmount**
    - **Validates: Requirements 19.8**

- [x] 12. Scorecard rendering and export
  - [x] 12.1 Implement the Scorecard and image export
    - Render a Scorecard with track title, group total score, and per-Player contributions; generate a downloadable raster image via canvas `toBlob` matching the on-screen content; provide copy/download controls and transparent retry on export failure
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [-]* 12.2 Write property test for scorecard content
    - **Property 33: Scorecard content reflects the round result**
    - **Validates: Requirements 11.1**

  - [ ]* 12.3 Write unit test for export controls and retry
    - Cover copy/download controls and the transparent export-retry path
    - _Requirements: 11.4, 11.5_

- [ ] 13. Single-player host and fixed-timestep loop
  - [~] 13.1 Implement the fixed-timestep loop and LocalGameHost
    - Drive `GameCore` with a `requestAnimationFrame` accumulator at a ~33.3ms step decoupled from render rate, render with interpolation `alpha`, and have the `LocalGameHost` run the scheduler, round lifecycle, Audio_Player, and Renderer fully in-browser with no network
    - _Requirements: 14.2, 14.6, 15.1, 15.2_

  - [ ]* 13.2 Write unit test for single-player end-to-end round
    - Drive selection → spawn → grab/order → scoring → result without a multiplayer connection
    - _Requirements: 15.1, 15.2_

- [ ] 14. Single-player UI shell and premium surfaces
  - [~] 14.1 Implement the React UI shell and wire single-player end-to-end
    - Build routing and the Premium_Entry_Surfaces (Landing_Page, Lobby) with clean dark layout, refined typography, semantic headings, labeled controls, body-text contrast ≥ 4.5:1, and the Reduce_Motion_Mode toggle; host the `<canvas>` during a Round; wire Song_Picker → resolvers → LocalGameHost → Renderer → Scorecard into a complete single-player flow
    - _Requirements: 13.4, 13.5, 15.1, 18.1, 18.2_

  - [ ]* 14.2 Write static-audit tests for premium surfaces and accessibility
    - Audit premium-surface styling, absence of Spotify branding, body-text contrast ≥ 4.5:1, semantic headings/labels, and ScrollReveal usage restrictions plus the gsap dependency
    - _Requirements: 13.4, 13.5, 18.1, 18.2, 18.5, 19.3, 19.4, 19.7_

- [~] 15. Checkpoint - Single-player complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Game_Server: Room Manager and join links
  - [x] 16.1 Implement the Room Manager
    - Create Rooms with collision-checked unique Room_Codes and designate the creator as Host; admit joins with session-scoped Player_Ids and generated default names with no account or install required; enforce max-player capacity with a `room_full` result; release all locks and remove a player on disconnect; restore room and identity on reconnect within the window
    - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.2, 2.5, 2.6, 8.8_

  - [ ]* 16.2 Write property test for unique codes and host designation
    - **Property 1: Room codes are unique and creator is host**
    - **Validates: Requirements 1.1**

  - [ ]* 16.3 Write property test for capacity enforcement
    - **Property 3: Room capacity is enforced**
    - **Validates: Requirements 1.5**

  - [ ]* 16.4 Write property test for player identity and default names
    - **Property 4: Player identity is unique with a default name**
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 16.5 Write property test for disconnect lock release
    - **Property 5: Disconnect releases all of a player's locks**
    - **Validates: Requirements 2.5, 8.8**

  - [ ]* 16.6 Write property test for reconnection restoration
    - **Property 6: Reconnection restores room and identity**
    - **Validates: Requirements 2.6**

  - [x] 16.7 Implement join-link build and parse
    - Build a shareable join link embedding the Room_Code and parse it back to the original code; surface a "room not found" result for unknown codes
    - _Requirements: 1.2, 1.4_

  - [x]* 16.8 Write property test for join-link round trip
    - **Property 2: Join-link round trip**
    - **Validates: Requirements 1.2**

  - [~] 16.9 Implement the authoritative tick loop and State Broadcaster
    - Run the authoritative `GameCore` on a fixed ~30Hz server tick driving the scheduler and round lifecycle; broadcast Rope_Letter positions, lock states, cursor presence, and provisional scores at ≥15Hz, and send a full authoritative snapshot to any client joining a Round in progress
    - _Requirements: 2.3, 2.4, 9.3, 14.6, 16.1, 16.3_

- [ ] 17. Networking, prediction, and reconciliation
  - [x] 17.1 Implement clock-offset estimation
    - Run the connection handshake computing `offset = (T_server + (T_receive - T_send)/2) - T_client`, repeating and keeping the median to align local ticks with the server timeline
    - _Requirements: 16.5_

  - [x]* 17.2 Write property test for clock-offset estimation
    - **Property 38: Clock-offset estimation aligns timelines**
    - **Validates: Requirements 16.5**

  - [~] 17.3 Implement the Net Client protocol, prediction decision, and reconciliation
    - (De)serialize the message protocol (`join`/`cursor`/`grab`/`release`/`startRound`; `welcome`/`roster`/`snapshot`/`grabResult`/`roundState`); apply client-side prediction to a grab iff the target is not visibly locked by another player; on each snapshot overwrite authoritative fields, re-apply pending local inputs, and snap contradicted grabs to authoritative state
    - _Requirements: 8.5, 8.6, 8.7, 14.4, 14.5, 16.2, 16.4_

  - [ ]* 17.4 Write property test for the prediction decision
    - **Property 23: Prediction decision matches grab visibility**
    - **Validates: Requirements 8.5, 8.6**

  - [ ]* 17.5 Write property test for reconciliation
    - **Property 24: Reconciliation makes the client match the authoritative state**
    - **Validates: Requirements 8.7, 14.5, 16.2, 16.4**

  - [~] 17.6 Implement the RemoteGameHost
    - Connect over WebSocket, keep a prediction `GameCore` for owned letters, drive non-owned letters from interpolated authoritative snapshots, and present the same host interface to the Renderer as the LocalGameHost
    - _Requirements: 16.1, 16.2_

  - [ ]* 17.7 Write integration tests for connection and broadcast behavior
    - Verify connect-within-5s, roster/cursor/snapshot broadcast rates (≥15Hz), the ~30Hz server tick, and join-in-progress state delivery using representative cases
    - _Requirements: 1.3, 2.3, 2.4, 14.6, 16.1, 16.3_

- [ ] 18. Multiplayer layering and mode equivalence
  - [~] 18.1 Wire the multiplayer layer onto single-player
    - Switch the UI shell between LocalGameHost and RemoteGameHost so Room presence, Cursor sharing, and Ownership_Locks layer on top of the existing single-player gameplay without altering ordering/scoring; fall back to Single_Player_Mode when multiplayer is unavailable
    - _Requirements: 15.2, 15.4, 16.1_

  - [ ]* 18.2 Write property test for mode-invariant scoring
    - **Property 30: Scoring is mode-invariant**
    - **Validates: Requirements 9.7, 15.3, 15.4**
    - Run the identical arrangement through the LocalGameHost and a RemoteGameHost-backed authoritative `GameCore` and assert equal scores

- [~] 19. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements clauses for traceability, and each property test names the exact design property it implements.
- The pure `GameCore`, LRC parser, Piped resolver, scoring, clock-offset math, and scroll-reveal mapping are the primary property-testing targets; property tests use `fast-check` with a minimum of 100 generated cases and seed `GameCore` for reproducible, shrinkable failures.
- Integration and static-audit tests use 1–3 representative cases (rates, Web Audio wiring, art direction, accessibility) rather than 100+ iterations.
- Checkpoints (tasks 5, 15, 19) provide incremental validation: GameCore core, single-player complete, and full multiplayer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.9", "3.1", "7.1", "8.1", "16.7", "17.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.6", "2.10", "3.2", "3.3", "7.2", "7.3", "8.2", "8.3", "10.1", "11.1", "16.8", "17.2"] },
    { "id": 4, "tasks": ["2.4", "2.5", "2.7", "2.8", "2.11", "3.4", "3.5", "4.1", "10.2", "10.3", "10.4", "10.5", "10.6", "11.2", "11.3", "11.4", "11.5"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 6, "tasks": ["4.5", "4.6", "4.7"] },
    { "id": 7, "tasks": ["4.8", "4.9", "4.10", "4.11", "4.12"] },
    { "id": 8, "tasks": ["4.13", "6.1", "9.1", "12.1", "16.1"] },
    { "id": 9, "tasks": ["6.2", "6.3", "9.2", "9.3", "9.4", "12.2", "12.3", "16.2", "16.3", "16.4", "16.5", "16.6"] },
    { "id": 10, "tasks": ["6.4", "6.5", "6.6", "13.1", "16.9"] },
    { "id": 11, "tasks": ["13.2", "14.1", "17.3"] },
    { "id": 12, "tasks": ["14.2", "17.4", "17.5", "17.6"] },
    { "id": 13, "tasks": ["17.7", "18.1"] },
    { "id": 14, "tasks": ["18.2"] }
  ]
}
```
