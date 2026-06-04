/**
 * `GameCore` — the concrete pure, deterministic gameplay engine.
 *
 * This class `implements GameCoreContract` (the interface in
 * `core/src/types/game-core.ts`). design.md shows the implementation as
 * `class GameCore`; to avoid a value/type name clash in the package barrel the
 * contract interface is named `GameCoreContract` and this runtime class keeps
 * the name `GameCore` (see the naming note on `GameCoreContract`).
 *
 * Pure module: NO imports of network, DOM, audio, or React — only the shared
 * types and the pure physics primitives. This is what makes the
 * single-player/multiplayer equivalence hold and property testing simple
 * (design.md "GameCore public surface").
 *
 * ## Scope of THIS class so far (tasks 4.1 + 4.4 + 4.7)
 * - Task 4.1: {@link GameCore.spawnLine} and Solution_Slot generation, plus the
 *   seeded PRNG used for deterministic spawn jitter.
 * - Task 4.4: {@link GameCore.applyInput} ownership-lock handling
 *   (grab/release/cursor) and held-letter steering toward the owner's cursor via
 *   {@link GameCore.tick} (which otherwise stays minimal). {@link GameCore.snapshot}
 *   now also emits the current Ownership_Locks.
 * - Task 4.7: Solution_Slot placement marking + scoring — {@link GameCore.evaluatePlacement}
 *   (tick step 6) marks each live letter's `placedSlot` by tolerance and keeps a
 *   provisional per-line score; {@link GameCore.finalizeLine} closes a line's drop
 *   window into a final per-line score and credits per-Player contributions;
 *   {@link GameCore.getRoundResult} accumulates the Round total + contributions;
 *   {@link GameCore.setTrackTitle} supplies the result's track title.
 *   {@link GameCore.snapshot} broadcasts the live provisional total. See the
 *   "Placement + scoring" note below.
 *
 * The remaining behavior ({@link GameCore.tick}'s integrate/relax/bounds/overlap
 * physics sequence, {@link GameCore.applySnapshot}) are minimal, type-correct
 * stubs filled in by task 4.12. Their stub strategy is documented on each method.
 *
 * ## Placement + scoring (task 4.7 — Requirements 9.2–9.7)
 * - **Representative position**: a letter's position is the centroid (mean) of
 *   its particle `x` positions. The 2-node chain's centroid is its midpoint.
 * - **Placement test (9.2)**: for each Solution_Slot of the letter's line, if the
 *   Euclidean distance from the centroid to `slot.position` is `<= slot.tolerance`,
 *   the slot is a candidate. The letter is placed in the NEAREST candidate;
 *   ties break to the LOWEST slot index. No candidate ⇒ `placedSlot = null`.
 * - **"Comes to rest" interpretation**: placement is determined purely by
 *   proximity-within-tolerance each evaluation (rest emerges from the physics
 *   settling). This is deterministic and pure; an optional velocity gate can be
 *   added in task 4.12 without changing this contract.
 * - **Correctly ordered**: a letter is "correctly ordered" iff
 *   `placedSlot === correctIndex` (placed in the slot matching its own correct
 *   position), NOT merely placed somewhere.
 * - **Provisional (9.3)**: while a line's drop window is OPEN (`finalized === null`),
 *   its provisional score = count of that line's letters that are correctly ordered.
 *   Recomputed every {@link GameCore.evaluatePlacement} (i.e. every tick).
 * - **Finalize (9.4)**: {@link GameCore.finalizeLine} closes the window, freezing
 *   `finalized` = count of that line's correctly-ordered letters at close, and
 *   credits one contribution per correctly-ordered letter (see attribution).
 * - **Accumulate (9.5)**: {@link GameCore.getRoundResult} returns `totalScore` =
 *   sum of all finalized per-line scores (open/unfinalized lines contribute 0).
 * - **Contribution attribution (9.6) + conservation (Property 29)**: each letter
 *   records its LAST owner (the most recent player to hold it, retained across
 *   release) in {@link lastOwnerByLetter}. On finalize, every correctly-ordered
 *   letter credits exactly ONE contribution — to its last owner, or to the
 *   deterministic {@link UNOWNED_CONTRIBUTOR} sentinel if it was never grabbed.
 *   Crediting exactly one key per counted letter makes the sum of contributions
 *   equal `totalScore` (Property 29) while keeping `finalized` faithful to 9.4
 *   (it counts ALL correctly-ordered letters, owned or not). The sentinel is the
 *   precise resolution of the never-owned edge: such letters still count toward
 *   the total AND are attributed, so conservation holds.
 * - **Mode-agnostic (9.7)**: scoring reads only `placedSlot`/`correctIndex`/last
 *   owner — no Single_Player/multiplayer branch — so SP and MP compute identical
 *   results from the same arrangement.
 * - **trackTitle**: GameCore does not know the track; {@link setTrackTitle} lets
 *   the host/round layer (tasks 6.3/13.1) supply it. Defaults to `''`.
 *
 * ## Tokenization: per-WORD (decision + spec citation)
 * Requirement 7.1 — "THE Physics_Engine SHALL spawn a Rope_Letter for each
 * letter **or** word in the Lyric_Line" — explicitly permits either granularity.
 * This implementation tokenizes **per word** (maximal runs of non-whitespace
 * characters), because:
 * - The product intro describes players who "grab different **words** or letters
 *   ... and drag them into the correct order"; words are the primary draggable
 *   unit, and the glossary defines a Rope_Letter as "a single letter **or word**".
 * - Requirement 9 scores the *ordering of Rope_Letters*; ordering a handful of
 *   word pieces is the intended puzzle, whereas ordering every character of a
 *   line would explode the piece count and collide with the concurrent-letter
 *   performance budget (Requirement 14.1).
 * - `RopeLetter.glyph` is documented as "the letter **or word** text".
 *
 * Whitespace runs are **excluded** from spawning (no rope-letter for a space),
 * and `correctIndex` / Solution_Slot indices run `0..n-1` over the NON-whitespace
 * tokens only (Requirements 7.1, 9.1). Switching to per-character later means
 * only changing {@link tokenize}; scoring in task 4.7 compares `correctIndex`
 * against the placed slot index regardless of token granularity.
 *
 * ## Rope-letter chain shape (decision)
 * Requirement 7.3 / the design model a Rope_Letter as "a chain of particles
 * connected by distance constraints". Each spawned token is therefore a fixed
 * **2-particle horizontal chain**: a left node and a right node joined by ONE
 * distance constraint. Both particles are free (movable), start at rest
 * (`prev === x`, zero implicit velocity), and have `invMass === 1`. The
 * constraint's `stiffness` comes from `config.defaultStiffness` and the node
 * collider radius from `config.colliderRadius`. Two particles is the smallest
 * shape that is still a real chain (not a single point) per the design, keeping
 * spawn allocations small while exercising the constraint solver.
 *
 * ## Glyph size → rest length (decision)
 * There is no font metric in pure `core`, so a sensible deterministic width is
 * derived from the glyph: `restLength = clamp(CHAR_WIDTH_PX * glyph.length,
 * MIN_CHAIN_LEN_PX, spawnBand.width)`. Longer words get longer ropes; a single
 * short token still gets at least `MIN_CHAIN_LEN_PX` so the chain is non-degenerate;
 * the clamp to the spawn-band width guarantees the chain fits inside the band.
 * The Renderer (task 9) owns true font metrics; this value only sizes physics.
 *
 * ## Spawn placement + deterministic jitter
 * Tokens are distributed across the top spawn band (`config.spawnBand`) and
 * jittered by the seeded PRNG so a given `(seed, line)` is fully reproducible
 * (design.md determinism note). For token `i` of `n`:
 * - the chain center is placed at fraction `(i + 0.5) / n` across the band's
 *   usable horizontal range (the range inset by half the chain length so the
 *   chain always fits), then nudged by a bounded seeded x-jitter and **clamped**
 *   back into the usable range — so every particle is guaranteed inside the band;
 * - the chain sits near the **top** of the band at `band.y + jitter` within the
 *   top quarter of the band height (a horizontal chain, so both nodes share `y`).
 *
 * Per token the PRNG is drawn in a FIXED order — `spawnJitterSeed`, then
 * x-jitter, then y-jitter — so identical seeds reproduce identical letters
 * (positions and `spawnJitterSeed`). `spawnJitterSeed` is a fresh 32-bit value
 * the Renderer later feeds into its own ransom-note rotation/placement variation
 * (Requirement 12.1); this task only assigns it deterministically.
 *
 * ## Solution_Slot layout (decision)
 * For a line with `n` tokens the slot sequence is `0..n-1` (Requirement 9.1),
 * where slot `i` is the target for the letter whose `correctIndex === i`. Slots
 * are laid out as a single fixed **answer row** across the play-area bounds
 * (`config.bounds`): slot `i` sits at x-fraction `(i + 0.5) / n` of the bounds
 * width and y at `ANSWER_ROW_FRACTION` of the bounds height (near the bottom).
 * Each slot uses `config.placementTolerance`. Slot positions are fully
 * deterministic with NO jitter — they are fixed targets, not tumbling pieces.
 *
 * ## Where Solution_Slots live (decision)
 * The LRC parser emits each `LyricLine` with `solutionSlots: []` to be filled at
 * spawn time (design: "slots are populated by `spawnLine`"). {@link spawnLine}
 * therefore fills the passed line's `solutionSlots` array in place AND stores the
 * same array in GameCore state (`solutionSlotsByLine`, keyed by `line.id`) so
 * later tasks (4.7 scoring, 4.12 snapshot) can read slots without re-deriving
 * them. The spawned letters live in the `letters` array.
 */

import type {
  GameConfig,
  GameCoreContract,
  LyricLine,
  PlayerInput,
  InputOutcome,
  RopeLetter,
  SolutionSlot,
  Snapshot,
  LockSnapshot,
  RoundResult,
  LineScore,
  Particle,
  Constraint,
  Vec2,
  PlayerId,
  CursorSnapshot,
} from '../types/index.js';
import { mulberry32, type Prng } from './prng.js';
import {
  integrateParticles,
  solveConstraints,
  resolveBounds,
  resolveOverlap,
} from '../physics/index.js';

/** Approximate rendered width of one glyph character, in px (physics sizing only). */
const CHAR_WIDTH_PX = 14;
/** Minimum chain rest length so even a 1-character token is a real 2-node chain. */
const MIN_CHAIN_LEN_PX = 12;
/** Fraction of the spawn-band height within which spawn `y` jitter is confined (near the top). */
const SPAWN_TOP_ZONE_FRACTION = 0.25;
/** Fraction of the play-area bounds height at which the answer row of slots sits (near the bottom). */
const ANSWER_ROW_FRACTION = 0.85;
/** Range used to map a PRNG float into a 32-bit `spawnJitterSeed`. */
const UINT32_RANGE = 4294967296; // 2 ** 32

/**
 * Sentinel contribution key for a correctly-ordered letter that was NEVER
 * grabbed by any Player (Requirement 9.6 / Property 29). The finalized per-line
 * score counts ALL correctly-ordered letters (faithful to 9.4), so an unowned
 * correct letter must still be attributed to SOME key for the per-player
 * contribution sum to equal the total (Property 29 — contributions conserve the
 * total). Crediting such letters to this deterministic sentinel keeps the
 * conservation invariant true without inventing a fake player; the sentinel is
 * not a real Player_Id and the UI can omit it. In Single_Player_Mode every
 * placed letter is grabbed by the one player, so the sentinel does not appear
 * there (Requirement 9.7).
 */
const UNOWNED_CONTRIBUTOR = '__unowned__';

/**
 * Particle index designated as the "grabbed node" of a held rope-letter — the
 * chain's first/left node (index 0). design.md tick step 2 says "For each owned
 * letter, set its grabbed node toward the owner's cursor"; it does not fix WHICH
 * node, so this implementation always grabs node 0 (the left end of the
 * 2-particle chain from {@link GameCore.createRopeLetter}). The rest of the chain
 * follows via the distance constraints on subsequent ticks. Tracking the index
 * as a constant (rather than per-letter) keeps `steerHeldLetters`/release simple
 * and allocation-free while leaving room to generalize later.
 */
const GRABBED_NODE_INDEX = 0;

/** Clamp `v` into the inclusive range `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export class GameCore implements GameCoreContract {
  /** Static physics / spawn / placement configuration. */
  private readonly config: GameConfig;
  /** Deterministic PRNG used for spawn jitter (seeded from the constructor seed). */
  private readonly prng: Prng;

  /** All rope-letters spawned so far, in spawn order. Read by later tasks (locks/scoring). */
  private readonly _letters: RopeLetter[] = [];
  /** Solution_Slot sequences keyed by lineId, populated by {@link spawnLine}. */
  private readonly solutionSlotsByLine = new Map<string, SolutionSlot[]>();
  /**
   * Letter lookup by id, kept in sync with {@link _letters} as letters spawn, so
   * `applyInput` resolves a `letterId` in O(1) without scanning the array.
   */
  private readonly lettersById = new Map<string, RopeLetter>();
  /**
   * Latest known cursor position per Player (Requirement 8.3 / 2.4). Recorded by
   * `cursor` inputs and read by {@link steerHeldLetters} to drive held letters.
   * One reused {@link Vec2} per player is mutated in place to avoid per-input
   * allocation; never aliased into letter/particle state.
   */
  private readonly cursors = new Map<PlayerId, Vec2>();
  /**
   * Maps a held letter's id → the particle index currently pinned as its grabbed
   * node, so {@link applyInput} on release unpins EXACTLY that node (restoring
   * `pinned=false`, `invMass=1`). An entry exists iff the letter is currently
   * held with a pinned grabbed node. See {@link GRABBED_NODE_INDEX}.
   */
  private readonly grabbedNodeByLetter = new Map<string, number>();
  /** Authoritative tick counter; advanced by the real tick sequence in task 4.12. */
  private currentTick = 0;

  /**
   * Per-line score state keyed by lineId (Requirement 9.3/9.4). An entry is
   * created lazily when a line is first evaluated or spawned. `provisional` is
   * recomputed every {@link evaluatePlacement} while the window is open;
   * `finalized` is `null` until {@link finalizeLine} closes the window, after
   * which `provisional` is frozen equal to `finalized`.
   */
  private readonly lineScores = new Map<string, LineScore>();
  /**
   * Per-Player contribution counts accumulated at line finalization
   * (Requirement 9.6). Keyed by the crediting Player_Id, or
   * {@link UNOWNED_CONTRIBUTOR} for correctly-ordered letters that were never
   * grabbed. The sum of all values equals the Round total (Property 29).
   */
  private readonly contributionsByPlayer = new Map<PlayerId, number>();
  /**
   * Last owner per letter id — the most recent Player to hold an Ownership_Lock
   * on the letter, RETAINED after release (Requirement 9.6 attribution). Set on
   * grab; never cleared on release, so a letter dragged into place and then let
   * go still credits the player who placed it. A letter never grabbed has no
   * entry and is attributed to {@link UNOWNED_CONTRIBUTOR} on finalize.
   */
  private readonly lastOwnerByLetter = new Map<string, PlayerId>();
  /**
   * Track title for {@link getRoundResult} (Requirement 9.6 result). GameCore is
   * pure and does not know the selected track, so the host/round layer supplies
   * it via {@link setTrackTitle}; defaults to `''`.
   */
  private roundTitle = '';

  /**
   * Construct a `GameCore`. Mirrors design.md's `new GameCore(seed, config)`.
   *
   * @param seed Deterministic seed; identical seeds + spawn calls reproduce identical state.
   * @param config Static physics/spawn/placement/session configuration.
   */
  constructor(seed: number, config: GameConfig) {
    this.config = config;
    this.prng = mulberry32(seed);
  }

  // -------------------------------------------------------------------------
  // Read accessors (not part of GameCoreContract; used by tests + later tasks)
  // -------------------------------------------------------------------------

  /** All rope-letters spawned so far (live reference; do not mutate externally). */
  get letters(): readonly RopeLetter[] {
    return this._letters;
  }

  /** The Solution_Slot sequence generated for `lineId`, or `undefined` if not spawned. */
  getSolutionSlots(lineId: string): readonly SolutionSlot[] | undefined {
    return this.solutionSlotsByLine.get(lineId);
  }

  /**
   * The {@link LineScore} for `lineId`, or `undefined` if the line has neither
   * been spawned nor evaluated. The returned object is the live internal record
   * (do not mutate externally); `finalized` is `null` while the drop window is
   * open (Requirements 9.3, 9.4).
   */
  getLineScore(lineId: string): LineScore | undefined {
    return this.lineScores.get(lineId);
  }

  /**
   * The current total provisional score across all live lines — the value
   * broadcast by {@link snapshot} (Requirement 9.3). Equals the sum over every
   * tracked line of its current per-line score (provisional while open, frozen
   * `finalized` after close). Reflects the most recent {@link evaluatePlacement}.
   */
  get provisionalScore(): number {
    let total = 0;
    for (const score of this.lineScores.values()) {
      total += score.finalized ?? score.provisional;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Task 4.7: track title (host/round layer supplies the round result's title)
  // -------------------------------------------------------------------------

  /**
   * Set the track title returned by {@link getRoundResult} (Requirement 9.6).
   * GameCore is pure and has no knowledge of the selected track, so the
   * host/round layer (tasks 6.3/13.1) supplies it. Defaults to `''`.
   */
  setTrackTitle(title: string): void {
    this.roundTitle = title;
  }

  // -------------------------------------------------------------------------
  // Task 4.1: spawnLine + Solution_Slot generation
  // -------------------------------------------------------------------------

  /**
   * Spawn exactly one {@link RopeLetter} per non-whitespace token of `line` at
   * the top of the play area, and generate the line's `0..n-1` Solution_Slot
   * sequence aligned to the correct order (Requirements 7.1, 9.1, 12.1).
   *
   * The passed line's `solutionSlots` array is filled in place (the LRC parser
   * emits it empty to be populated here) and the same array is stored in
   * GameCore state for later tasks. Deterministic given the construction seed.
   */
  spawnLine(line: LyricLine): void {
    const tokens = GameCore.tokenize(line.text);
    const n = tokens.length;

    const slots: SolutionSlot[] = [];

    if (n > 0) {
      for (let i = 0; i < n; i++) {
        // PRNG draw order is FIXED per token for reproducibility:
        // 1) spawnJitterSeed, 2) x-jitter, 3) y-jitter.
        const spawnJitterSeed = Math.floor(this.prng() * UINT32_RANGE);
        const xJitterUnit = this.prng(); // [0, 1)
        const yJitterUnit = this.prng(); // [0, 1)

        const letter = this.createRopeLetter(
          line.id,
          i,
          n,
          tokens[i]!,
          spawnJitterSeed,
          xJitterUnit,
          yJitterUnit,
        );
        this._letters.push(letter);
        this.lettersById.set(letter.id, letter);

        slots.push(this.createSolutionSlot(i, n));
      }
    }

    // Fill the caller's array in place (parser emits it empty) and store it.
    line.solutionSlots.length = 0;
    for (let i = 0; i < slots.length; i++) line.solutionSlots.push(slots[i]!);
    this.solutionSlotsByLine.set(line.id, line.solutionSlots);

    // Open this line's drop window with a zeroed provisional score (Requirement
    // 9.3). evaluatePlacement updates it each tick; finalizeLine closes it.
    if (!this.lineScores.has(line.id)) {
      this.lineScores.set(line.id, { lineId: line.id, provisional: 0, finalized: null });
    }
  }

  /**
   * Split `text` into ordered per-word tokens — maximal runs of non-whitespace
   * characters — excluding whitespace (see the class "Tokenization" note).
   */
  private static tokenize(text: string): string[] {
    const matches = text.match(/\S+/g);
    return matches ?? [];
  }

  /**
   * Build one rope-letter as a 2-particle horizontal chain positioned within the
   * spawn band, using the supplied deterministic jitter units.
   */
  private createRopeLetter(
    lineId: string,
    index: number,
    tokenCount: number,
    glyph: string,
    spawnJitterSeed: number,
    xJitterUnit: number,
    yJitterUnit: number,
  ): RopeLetter {
    const band = this.config.spawnBand;

    // Chain length from glyph size, clamped to fit inside the band.
    const rawLen = CHAR_WIDTH_PX * glyph.length;
    const restLength = clamp(rawLen, MIN_CHAIN_LEN_PX, band.width);
    const halfLen = restLength / 2;

    // Usable horizontal range so the whole chain stays inside the band.
    const usableLeft = band.x + halfLen;
    const usableRight = band.x + band.width - halfLen;
    // Even base distribution across the band, then bounded seeded x-jitter,
    // clamped back into the usable range (guarantees in-band particles).
    const baseFrac = (index + 0.5) / tokenCount;
    const span = usableRight - usableLeft;
    const baseX = usableLeft + baseFrac * span;
    // x-jitter spans up to one inter-token gap, centered on the base position.
    const maxXJitter = span > 0 ? span / tokenCount / 2 : 0;
    const jitterX = (xJitterUnit - 0.5) * 2 * maxXJitter;
    const centerX = clamp(baseX + jitterX, usableLeft, usableRight);

    // Near the top of the band: y within the top zone, always inside the band.
    const topZone = band.height * SPAWN_TOP_ZONE_FRACTION;
    const centerY = clamp(band.y + yJitterUnit * topZone, band.y, band.y + band.height);

    const left = GameCore.freeParticle(centerX - halfLen, centerY);
    const right = GameCore.freeParticle(centerX + halfLen, centerY);
    const constraint: Constraint = {
      a: 0,
      b: 1,
      restLength,
      stiffness: this.config.defaultStiffness,
    };

    return {
      id: `${lineId}:${index}`,
      glyph,
      lineId,
      particles: [left, right],
      constraints: [constraint],
      colliderRadius: this.config.colliderRadius,
      ownerId: null,
      placedSlot: null,
      correctIndex: index,
      spawnJitterSeed,
    };
  }

  /**
   * Build the Solution_Slot for correct position `index` of `tokenCount`,
   * laid out on a single answer row across the play-area bounds.
   */
  private createSolutionSlot(index: number, tokenCount: number): SolutionSlot {
    const bounds = this.config.bounds;
    const frac = (index + 0.5) / tokenCount;
    return {
      index,
      position: {
        x: bounds.x + frac * bounds.width,
        y: bounds.y + ANSWER_ROW_FRACTION * bounds.height,
      },
      tolerance: this.config.placementTolerance,
    };
  }

  /** A free (movable) particle at `(x, y)` starting at rest (`prev === x`). */
  private static freeParticle(x: number, y: number): Particle {
    return { x: { x, y }, prev: { x, y }, pinned: false, invMass: 1 };
  }

  // -------------------------------------------------------------------------
  // Stubs — minimal, type-correct placeholders for later tasks.
  // -------------------------------------------------------------------------

  /**
   * Apply one player input, enforcing Ownership_Locks and recording cursors
   * (Requirements 8.1, 8.2, 8.4; cursor presence 8.3/2.4). Side-effects only
   * GameCore-internal state — the per-player cursor map, the per-letter
   * `ownerId`, and the grabbed-node tracking map. It does NOT move particles;
   * held-letter steering happens in {@link tick} via {@link steerHeldLetters}
   * so movement is deterministic with the rest of the step sequence.
   *
   * Documented decisions:
   * - **grab on a missing letter** (`letterId` not found): returns
   *   `{ granted:false, ownerId:null }` and changes nothing — there is no lock to
   *   assign and no current owner to report. This is treated as a benign no-op
   *   rather than an error so a stale client `letterId` cannot throw on the
   *   authoritative core.
   * - **grab on a letter you already own** (same-player re-grab): idempotent —
   *   returns `{ granted:true, ownerId: you }` without re-pinning or disturbing
   *   the existing grabbed node. Re-grabbing your own letter is NOT a denial
   *   (Requirement 8.2 denies only grabs on letters locked by *another* player).
   * - **release of a non-owned letter** (owned by someone else, or already
   *   unlocked): returns `{ released:false }` and changes nothing — a player may
   *   only clear their own lock (Requirement 8.4).
   */
  applyInput(input: PlayerInput): InputOutcome {
    switch (input.type) {
      case 'cursor':
        return this.applyCursor(input.playerId, input.x, input.y);
      case 'grab':
        return this.applyGrab(input.playerId, input.letterId);
      case 'release':
        return this.applyRelease(input.playerId, input.letterId);
    }
  }

  /**
   * Record `playerId`'s latest cursor position (Requirement 8.3 / 2.4). Mutates
   * the player's existing reused {@link Vec2} in place when present, else stores
   * a fresh one, so steady cursor streams do not allocate per input.
   */
  private applyCursor(playerId: PlayerId, x: number, y: number): InputOutcome {
    const existing = this.cursors.get(playerId);
    if (existing) {
      existing.x = x;
      existing.y = y;
    } else {
      this.cursors.set(playerId, { x, y });
    }
    return { type: 'cursor', accepted: true };
  }

  /**
   * Assign an Ownership_Lock on an unlocked letter to the requester (8.1), deny
   * a grab on a letter locked by another player and report the current owner
   * (8.2), and treat a same-owner re-grab as idempotent. Marks the grabbed node
   * pinned so {@link steerHeldLetters} can steer it; the actual move to the
   * cursor happens on the next {@link tick}.
   */
  private applyGrab(playerId: PlayerId, letterId: string): InputOutcome {
    const letter = this.lettersById.get(letterId);

    // Missing letter: benign no-op, nothing to lock and no owner to report.
    if (!letter) {
      return { type: 'grab', letterId, granted: false, ownerId: null };
    }

    // Locked by another player: deny, reporting the current lock holder (8.2).
    if (letter.ownerId !== null && letter.ownerId !== playerId) {
      return { type: 'grab', letterId, granted: false, ownerId: letter.ownerId };
    }

    // Unlocked (8.1) or already owned by the requester (idempotent re-grab).
    if (letter.ownerId === null) {
      letter.ownerId = playerId;
      this.pinGrabbedNode(letter);
    }
    // Record the last owner for contribution attribution (Requirement 9.6).
    // Retained across release so the player who places a letter is credited.
    this.lastOwnerByLetter.set(letterId, playerId);
    return { type: 'grab', letterId, granted: true, ownerId: playerId };
  }

  /**
   * Clear the requester's Ownership_Lock on a letter and unpin its grabbed node
   * (Requirement 8.4). A release of a letter the requester does not own (someone
   * else's lock, or an unlocked letter) is a no-op returning `released:false`.
   */
  private applyRelease(playerId: PlayerId, letterId: string): InputOutcome {
    const letter = this.lettersById.get(letterId);

    if (!letter || letter.ownerId !== playerId) {
      return { type: 'release', letterId, released: false };
    }

    letter.ownerId = null;
    this.unpinGrabbedNode(letter);
    return { type: 'release', letterId, released: true };
  }

  /**
   * Pin the {@link GRABBED_NODE_INDEX} node of `letter` (set `pinned=true`,
   * `invMass=0`) and record it in {@link grabbedNodeByLetter} so release can
   * restore exactly that node. Idempotent: if the letter already has a tracked
   * grabbed node this does nothing.
   */
  private pinGrabbedNode(letter: RopeLetter): void {
    if (this.grabbedNodeByLetter.has(letter.id)) return;
    const node = letter.particles[GRABBED_NODE_INDEX];
    if (!node) return; // defensive: a degenerate letter with no particles.
    node.pinned = true;
    node.invMass = 0;
    this.grabbedNodeByLetter.set(letter.id, GRABBED_NODE_INDEX);
  }

  /**
   * Restore the previously pinned grabbed node of `letter` to a free particle
   * (`pinned=false`, `invMass=1`) and drop its {@link grabbedNodeByLetter} entry.
   * Uses the tracked node index so exactly the node pinned on grab is unpinned.
   */
  private unpinGrabbedNode(letter: RopeLetter): void {
    const index = this.grabbedNodeByLetter.get(letter.id);
    if (index === undefined) return;
    const node = letter.particles[index];
    if (node) {
      node.pinned = false;
      node.invMass = 1;
    }
    this.grabbedNodeByLetter.delete(letter.id);
  }

  // -------------------------------------------------------------------------
  // Task 4.7: Solution_Slot placement marking + provisional/finalized scoring
  // -------------------------------------------------------------------------

  /**
   * Tick step 6 (design.md): evaluate Solution_Slot placement for every live
   * letter and refresh each OPEN line's provisional score (Requirements 9.2,
   * 9.3). Deterministic and allocation-light: it mutates only each letter's
   * `placedSlot` and the per-line `provisional` field, using two reused scalar
   * accumulators (no per-call allocation).
   *
   * Placement (9.2): a letter is placed in the nearest Solution_Slot of its line
   * whose distance to the letter's centroid is `<= slot.tolerance`; ties break to
   * the lowest slot index; no slot within tolerance ⇒ `placedSlot = null`. See
   * {@link placedSlotFor}.
   *
   * Provisional (9.3): for each OPEN line (`finalized === null`) the provisional
   * score is recomputed as the count of that line's letters that are correctly
   * ordered (`placedSlot === correctIndex`). Finalized lines are left frozen.
   */
  private evaluatePlacement(): void {
    // 1) Mark placement for every live letter (9.2).
    for (const letter of this._letters) {
      const slots = this.solutionSlotsByLine.get(letter.lineId);
      letter.placedSlot = slots ? GameCore.placedSlotFor(letter, slots) : null;
    }

    // 2) Refresh provisional per-line scores for OPEN windows (9.3).
    this.refreshProvisionalScores();
  }

  /**
   * Recompute each OPEN line's provisional score (Requirement 9.3) from the
   * letters' CURRENT `placedSlot` values — the count of that line's letters that
   * are correctly ordered (`placedSlot === correctIndex`). Lines whose window is
   * already closed (`finalized !== null`) are left frozen. Extracted from
   * {@link evaluatePlacement} so {@link applySnapshot} can rebuild the provisional
   * totals from reconciled `placedSlot` values WITHOUT re-deriving placement from
   * positions (the reconciling instance may not own this line's Solution_Slots);
   * this is what makes a reconciled provisional score match the snapshot's
   * (Property 37). Allocation-free: two reused scalar accumulators only.
   */
  private refreshProvisionalScores(): void {
    for (const score of this.lineScores.values()) {
      if (score.finalized !== null) continue; // window closed: frozen.
      score.provisional = 0;
    }
    for (const letter of this._letters) {
      if (letter.placedSlot !== letter.correctIndex) continue; // not correctly ordered.
      const score = this.lineScores.get(letter.lineId);
      if (score && score.finalized === null) score.provisional += 1;
    }
  }

  /**
   * Return the index of the Solution_Slot a letter is placed in, or `null`.
   * The letter's representative position is the centroid (mean) of its particle
   * `x` positions. Among slots within `tolerance` of that centroid, the NEAREST
   * (smallest distance) wins; ties break to the lowest slot index. Pure; no
   * allocation beyond the local centroid scalars.
   */
  private static placedSlotFor(letter: RopeLetter, slots: readonly SolutionSlot[]): number | null {
    const particles = letter.particles;
    const count = particles.length;
    if (count === 0) return null; // defensive: degenerate letter.

    let cx = 0;
    let cy = 0;
    for (const p of particles) {
      cx += p.x.x;
      cy += p.x.y;
    }
    cx /= count;
    cy /= count;

    let bestIndex: number | null = null;
    let bestDistSq = 0;
    for (const slot of slots) {
      const dx = cx - slot.position.x;
      const dy = cy - slot.position.y;
      const distSq = dx * dx + dy * dy;
      const tol = slot.tolerance;
      if (distSq > tol * tol) continue; // outside this slot's tolerance.
      // Nearest wins; strict `<` keeps the lowest index on an exact tie.
      if (bestIndex === null || distSq < bestDistSq) {
        bestIndex = slot.index;
        bestDistSq = distSq;
      }
    }
    return bestIndex;
  }

  /**
   * Close `lineId`'s drop window and finalize its per-line score (Requirement
   * 9.4), crediting per-Player contributions (Requirement 9.6). Idempotent: a
   * line already finalized is left unchanged so a double close cannot
   * double-credit contributions.
   *
   * Finalized score = count of the line's letters that are correctly ordered
   * (`placedSlot === correctIndex`) at close, using the current `placedSlot`
   * values (callers run {@link evaluatePlacement}/{@link tick} first so placement
   * reflects the final rest state). For each such letter, exactly ONE
   * contribution is credited — to its last owner ({@link lastOwnerByLetter}), or
   * to {@link UNOWNED_CONTRIBUTOR} when it was never grabbed — so the sum of
   * contributions equals the Round total (Property 29).
   *
   * Lines never spawned/tracked are created and finalized at 0 so a stray close
   * is a harmless no-op rather than an error.
   */
  finalizeLine(lineId: string): void {
    let score = this.lineScores.get(lineId);
    if (!score) {
      score = { lineId, provisional: 0, finalized: null };
      this.lineScores.set(lineId, score);
    }
    if (score.finalized !== null) return; // already closed: idempotent.

    let finalized = 0;
    for (const letter of this._letters) {
      if (letter.lineId !== lineId) continue;
      if (letter.placedSlot !== letter.correctIndex) continue; // not correctly ordered.
      finalized += 1;
      const contributor = this.lastOwnerByLetter.get(letter.id) ?? UNOWNED_CONTRIBUTOR;
      this.contributionsByPlayer.set(
        contributor,
        (this.contributionsByPlayer.get(contributor) ?? 0) + 1,
      );
    }

    score.finalized = finalized;
    // Freeze the provisional readout to match the finalized value (9.3/9.4).
    score.provisional = finalized;
  }

  /**
   * Remove every live Rope_Letter belonging to `lineId` from play, clearing the
   * heap so the next line has room (gameplay quality — without this every line's
   * letters accumulate forever and the play area becomes an unreadable pile).
   *
   * This does NOT touch scoring: the line's {@link LineScore} (provisional or
   * finalized) and any accumulated per-Player contributions are retained, so
   * clearing a line after it is finalized preserves the Round total. The
   * recommended sequence when a new line drops is `finalizeLine(prev)` then
   * `clearLine(prev)` so the just-closed line is scored before its letters are
   * removed.
   *
   * Removes the line's letters from {@link _letters} and {@link lettersById},
   * drops any pinned-grabbed-node bookkeeping for them (so a held letter that is
   * cleared cannot leave a dangling pin), and forgets their Solution_Slots. Safe
   * to call for an unknown/already-cleared line (no-op). Pure and deterministic.
   */
  clearLine(lineId: string): void {
    if (this._letters.length === 0) return;
    const kept: RopeLetter[] = [];
    for (const letter of this._letters) {
      if (letter.lineId === lineId) {
        // Drop per-letter bookkeeping so nothing dangles after removal.
        this.lettersById.delete(letter.id);
        this.grabbedNodeByLetter.delete(letter.id);
        // lastOwnerByLetter is intentionally retained: contributions are already
        // credited at finalize and keying is harmless once the letter is gone.
      } else {
        kept.push(letter);
      }
    }
    // Replace contents in place (the `letters` getter returns this same array).
    this._letters.length = 0;
    for (let i = 0; i < kept.length; i++) this._letters.push(kept[i]!);
    this.solutionSlotsByLine.delete(lineId);
  }

  /**
   * Steer every held letter's pinned grabbed node to its owner's latest cursor
   * (Requirement 8.3 — design.md tick step 2). Decision: SNAP (not a fractional
   * lerp). Because the grabbed node is pinned (`invMass=0`), integration and the
   * constraint solver leave it fixed, so writing its position each tick makes it
   * an exact cursor anchor; the remaining chain nodes are pulled toward it by the
   * distance constraints over subsequent relaxation passes. To keep the node a
   * true anchor with zero implicit velocity, both `x` and `prev` are set to the
   * cursor (a pinned node is skipped by integration anyway, but this keeps its
   * `x - prev` velocity at zero for consistency).
   *
   * A held letter whose owner has no recorded cursor yet is left in place. This
   * mutates only particle positions of already-pinned nodes; no allocation.
   * Called from {@link tick}; the rest of the deterministic step sequence is
   * wired up in task 4.12.
   */
  private steerHeldLetters(): void {
    for (const [letterId, nodeIndex] of this.grabbedNodeByLetter) {
      const letter = this.lettersById.get(letterId);
      if (!letter || letter.ownerId === null) continue;
      const cursor = this.cursors.get(letter.ownerId);
      if (!cursor) continue;
      const node = letter.particles[nodeIndex];
      if (!node) continue;
      node.x.x = cursor.x;
      node.x.y = cursor.y;
      node.prev.x = cursor.x;
      node.prev.y = cursor.y;
    }
  }

  /**
   * Advance the simulation one fixed step, running the full deterministic tick
   * sequence (design.md "Tick ordering (deterministic)"). A given seed + input
   * sequence is fully reproducible, which is what makes single-player/server
   * agreement and property testing hold (Requirement 7.6 — the server owns the
   * ground-truth physics this drives).
   *
   * The design's six-step order is realized as:
   *
   * 1. **Apply queued inputs / update Ownership_Locks.** This implementation
   *    applies inputs IMMEDIATELY in {@link applyInput} (cursors/locks/grabbed
   *    nodes are already updated synchronously), so by the time `tick` runs step
   *    1 is effectively complete — there is no separate input queue to drain.
   * 2. **Steer held letters** — {@link steerHeldLetters} snaps each owned
   *    letter's pinned grabbed node onto its owner's cursor (Requirement 8.3).
   * 3. **Verlet-integrate** all particles (gravity + damping).
   * 4. **Relax constraints** — `config.constraintIterations` passes per letter.
   * 5. **Resolve bounds, then inter-letter overlap.**
   * 6. **Evaluate placement / update provisional scores** —
   *    {@link evaluatePlacement} (Requirements 9.2, 9.3), run LAST.
   *
   * ## Sub-stepping (`config.subSteps`)
   * Steps 3–5 form the spatial solver. When `config.subSteps > 1` the solver is
   * run `subSteps` times with `dt = dtMs / subSteps` to stabilize fast drags
   * (design.md "Distance constraints" / research sub-stepping). Held grabbed
   * nodes are RE-STEERED at the top of every sub-step so they stay glued to the
   * cursor throughout the smaller steps (re-pinning is idempotent and cheap).
   * With the default `subSteps === 1` this collapses to a single solver pass, so
   * existing single-step behavior is unchanged.
   *
   * ## Held grabbed nodes are re-anchored AFTER spatial resolution (Req 8.3)
   * Requirement 8.3 says a held letter's node moves "toward the owning Player's
   * Cursor position". The grabbed node is pinned (`invMass 0`), so integration
   * and the constraint solver leave it fixed — but {@link resolveBounds} clamps
   * EVERY particle's position into the play-area rectangle (it only skips the
   * velocity *reflection* for fixed nodes, not the position clamp). A cursor
   * outside the bounds would therefore drag the clamp away from the cursor,
   * breaking the "node tracks the cursor" contract for off-screen cursors. To
   * keep the cursor the authoritative anchor regardless of bounds, held grabbed
   * nodes are RE-STEERED once more after bounds+overlap (a final re-pin). This is
   * a deliberate, documented refinement of the step order: spatial resolution
   * runs first (so the free chain nodes settle against walls/other letters), then
   * the held node is re-asserted to exactly equal the cursor. It is deterministic
   * (a pure function of the recorded cursor) and preserves Requirement 8.3
   * literally, including off-screen cursors.
   *
   * ## Allocation (Requirement 14.3)
   * The spatial primitives are allocation-free internally (module-level scratch).
   * This loop iterates the existing `_letters` / per-letter particle arrays in
   * place and allocates nothing per tick — no temporary flat particle array is
   * built; integration/bounds are applied per letter over `letter.particles`.
   *
   * @param dtMs Fixed timestep in milliseconds (typically `config.stepMs`).
   */
  tick(dtMs: number): void {
    // Step 1 is already done: applyInput updates cursors/locks synchronously.
    // Step 2: steer held grabbed nodes onto their owners' cursors.
    this.steerHeldLetters();

    // Steps 3–5: the spatial solver, optionally sub-stepped for stability.
    const subSteps = this.config.subSteps > 0 ? this.config.subSteps : 1;
    const subDt = dtMs / subSteps;
    for (let s = 0; s < subSteps; s++) {
      // Re-anchor held nodes at the start of each sub-step so they stay glued to
      // the cursor across the smaller steps (idempotent for subSteps === 1).
      if (s > 0) this.steerHeldLetters();
      this.runSpatialStep(subDt);
    }

    // Re-anchor held grabbed nodes AFTER bounds/overlap so the cursor is the
    // authoritative anchor even when it lies outside the play-area bounds
    // (Requirement 8.3 — see the method doc). resolveBounds clamps all particle
    // positions, so without this a held node tracking an off-screen cursor would
    // be pulled to the wall instead of the cursor.
    this.steerHeldLetters();

    // Step 6: placement + provisional scoring, run LAST.
    this.evaluatePlacement();

    // Advance the authoritative tick counter exactly once per tick() call.
    this.currentTick += 1;
  }

  /**
   * One spatial solver pass over all letters with timestep `dt` (design.md tick
   * steps 3–5): Verlet-integrate every particle, relax each letter's distance
   * constraints `config.constraintIterations` times, then resolve play-area
   * bounds followed by inter-letter overlap. Mutates particle state in place;
   * allocates nothing per call (the primitives use module-level scratch). Pinned
   * grabbed nodes are skipped by integration/constraints and only position-
   * clamped by bounds, so steering remains authoritative (see {@link tick}).
   */
  private runSpatialStep(dt: number): void {
    const gravity = this.config.gravity;
    const damping = this.config.damping;
    const iterations = this.config.constraintIterations;

    // Step 3 + 4 per letter: integrate this letter's particles, then relax its
    // constraints. Iterating per letter avoids building a transient flat array.
    for (const letter of this._letters) {
      integrateParticles(letter.particles, dt, gravity, damping);
      solveConstraints(letter.particles, letter.constraints, iterations);
    }

    // Step 5a: clamp/reflect every particle inside the play-area bounds.
    for (const letter of this._letters) {
      resolveBounds(letter.particles, this.config.bounds, this.config.restitution);
    }

    // Step 5b: push overlapping cross-letter nodes apart so letters stack.
    resolveOverlap(this._letters);
  }

  /**
   * Produce the full authoritative snapshot for ≥15Hz broadcast, client
   * reconciliation, and join-in-progress hydration (Requirements 16.1, 16.3,
   * and the design `snapshot` message: `letters[]`, `locks[]`, `cursors[]`,
   * `provisionalScore`, `tick`). All nested {@link Vec2} values are COPIED, never
   * aliased to internal particle/cursor state, so a consumer mutating the
   * snapshot cannot corrupt the engine.
   *
   * - `tick` — the authoritative {@link currentTick} counter (advanced once per
   *   {@link tick}).
   * - `letters` — every live rope-letter's particle `x`/`prev` pair and
   *   `placedSlot`, in spawn order (Requirement 16.3).
   * - `locks` — every letter whose `ownerId !== null` as a `{ letterId, ownerId }`
   *   {@link LockSnapshot}, in spawn order (deterministic) (Requirements 8.1, 16.1).
   * - `cursors` — every Player with a recorded cursor as a
   *   `{ playerId, cursor }` {@link CursorSnapshot}, with the position copied
   *   (Requirement 2.4 presence). Map iteration order is insertion order, which
   *   is deterministic for a given input sequence.
   * - `provisionalScore` — the live total ({@link provisionalScore}) broadcast to
   *   Clients (Requirement 9.3).
   */
  snapshot(): Snapshot {
    const locks: LockSnapshot[] = [];
    for (const l of this._letters) {
      if (l.ownerId !== null) locks.push({ letterId: l.id, ownerId: l.ownerId });
    }
    const cursors: CursorSnapshot[] = [];
    for (const [playerId, cursor] of this.cursors) {
      cursors.push({ playerId, cursor: { x: cursor.x, y: cursor.y } });
    }
    return {
      tick: this.currentTick,
      letters: this._letters.map((l) => ({
        id: l.id,
        particles: l.particles.map((p) => ({
          x: { x: p.x.x, y: p.x.y },
          prev: { x: p.prev.x, y: p.prev.y },
        })),
        placedSlot: l.placedSlot,
      })),
      locks,
      cursors,
      provisionalScore: this.provisionalScore,
    };
  }

  /**
   * Reconcile this instance's authoritative state toward `s` (Requirements 16.2,
   * 16.3): overwrite letter positions, resting placement, Ownership_Locks,
   * cursors, the tick counter, and the provisional score so a fresh GameCore (or
   * a client prediction copy) reproduces the snapshot's state. Applying a
   * snapshot taken from another GameCore with the same spawned letters yields
   * equal letter positions, locks, and provisional score (Property 37).
   *
   * Order and rationale:
   * 1. **Letters** — for each {@link LetterSnapshot}, find the local letter by id
   *    and overwrite each particle's `x`/`prev` (values copied, never aliased)
   *    and `placedSlot`. Particle arrays are matched index-by-index up to the
   *    shorter length, so a benign shape mismatch cannot throw. A snapshot letter
   *    with NO local match is SKIPPED (a stale/foreign id cannot corrupt state);
   *    a local letter ABSENT from the snapshot is left unchanged (the snapshot is
   *    authoritative only for the letters it carries — standard reconciliation).
   * 2. **Locks** — {@link reconcileLocks} sets each letter's `ownerId` from
   *    `s.locks`, clearing owners not present, and keeps the pinned-grabbed-node
   *    bookkeeping in sync so a reconstructed held letter behaves like the
   *    authoritative one on subsequent ticks (Requirements 8.1, 16.1).
   * 3. **Cursors** — rebuilt from `s.cursors` (values copied) so presence and
   *    held-letter steering match the authoritative state (Requirement 2.4).
   * 4. **Tick** — `currentTick` is set to `s.tick` so the reconciled timeline
   *    aligns with the authoritative one.
   * 5. **Provisional score** — recomputed from the just-applied `placedSlot`
   *    values via {@link refreshProvisionalScores} (NOT from positions), so the
   *    per-line provisional totals sum to the snapshot's `provisionalScore`
   *    without depending on this instance having generated Solution_Slots. Open
   *    lines are refreshed; already-finalized lines stay frozen (Requirement 9.3).
   */
  applySnapshot(s: Snapshot): void {
    // 1) Letter positions + resting placement (skip unknown ids).
    for (const ls of s.letters) {
      const letter = this.lettersById.get(ls.id);
      if (!letter) continue; // snapshot letter not present locally: skip.
      const count = Math.min(letter.particles.length, ls.particles.length);
      for (let i = 0; i < count; i++) {
        const dst = letter.particles[i]!;
        const src = ls.particles[i]!;
        dst.x.x = src.x.x;
        dst.x.y = src.x.y;
        dst.prev.x = src.prev.x;
        dst.prev.y = src.prev.y;
      }
      letter.placedSlot = ls.placedSlot;
    }

    // 2) Ownership_Locks (owner ids + pinned-node bookkeeping).
    this.reconcileLocks(s.locks);

    // 3) Cursors — rebuild from the snapshot (copy values, never alias).
    this.cursors.clear();
    for (const cs of s.cursors) {
      this.cursors.set(cs.playerId, { x: cs.cursor.x, y: cs.cursor.y });
    }

    // 4) Authoritative tick counter.
    this.currentTick = s.tick;

    // 5) Provisional scores from the applied placedSlot values (open lines only).
    this.refreshProvisionalScores();
  }

  /**
   * Reconcile every letter's `ownerId` toward the authoritative `locks`
   * (Requirements 8.1, 16.1, 16.2). A letter present in `locks` is set to that
   * owner; a letter absent from `locks` has any current owner cleared. The
   * pinned-grabbed-node tracking ({@link grabbedNodeByLetter}) and
   * {@link lastOwnerByLetter} attribution are kept in sync via the existing
   * pin/unpin helpers so a reconstructed held letter is pinned exactly like the
   * authoritative one (its grabbed node skips integration and is steered to the
   * owner's cursor on the next tick). Only changed letters are touched, so an
   * unchanged lock set is a cheap no-op. Locks referencing an unknown letter id
   * are ignored (a stale/foreign id cannot create a phantom lock).
   */
  private reconcileLocks(locks: readonly LockSnapshot[]): void {
    const desired = new Map<string, PlayerId>();
    for (const lock of locks) {
      if (this.lettersById.has(lock.letterId)) desired.set(lock.letterId, lock.ownerId);
    }
    for (const letter of this._letters) {
      const want = desired.get(letter.id) ?? null;
      if (want === letter.ownerId) continue; // already matches: nothing to do.

      // Clear an existing (now-stale) owner and unpin its grabbed node.
      if (letter.ownerId !== null) {
        this.unpinGrabbedNode(letter);
        letter.ownerId = null;
      }
      // Assign the authoritative owner and re-pin its grabbed node (positions
      // were already set from the snapshot; pinning does not move the node).
      if (want !== null) {
        letter.ownerId = want;
        this.pinGrabbedNode(letter);
        this.lastOwnerByLetter.set(letter.id, want);
      }
    }
  }

  /**
   * Produce the finalized Round result (Requirements 9.5, 9.6). `totalScore` is
   * the sum of all FINALIZED per-line scores — lines whose drop window is still
   * open (`finalized === null`) contribute 0, so the total reflects only closed
   * lines (9.5). `contributions` is a snapshot copy of the per-Player counts
   * accumulated by {@link finalizeLine} (9.6); its values sum to `totalScore`
   * (Property 29), with never-owned correct letters keyed under the
   * {@link UNOWNED_CONTRIBUTOR} sentinel. `trackTitle` is whatever
   * {@link setTrackTitle} last supplied (default `''`).
   *
   * Pure read of accumulated state — calling it does not finalize anything; the
   * round/host layer closes each line via {@link finalizeLine} before reading.
   */
  getRoundResult(): RoundResult {
    let totalScore = 0;
    for (const score of this.lineScores.values()) {
      if (score.finalized !== null) totalScore += score.finalized;
    }
    const contributions: Record<PlayerId, number> = {};
    for (const [playerId, count] of this.contributionsByPlayer) {
      contributions[playerId] = count;
    }
    return { trackTitle: this.roundTitle, totalScore, contributions };
  }
}
