/**
 * Art-direction theme selection (task 8.1).
 *
 * Design references:
 * - Requirement 18.3: SHALL NOT apply the Premium_Entry_Surface art direction
 *   to the in-round gameplay play area.
 * - Requirement 18.4: WHILE a Round is in the playing state, the Renderer SHALL
 *   render the gameplay play area using the handmade aesthetic art direction
 *   (Requirement 12) rather than the Premium_Entry_Surface art direction.
 * - design.md "Overview": Non-gameplay surfaces (Landing_Page, Lobby,
 *   Song_Picker) are Premium_Entry_Surfaces (clean, dark, Spotify-style polish).
 *   The in-round play area uses the handmade zine/VHS/ransom-note aesthetic.
 *   "The two never bleed into each other."
 *
 * {@link selectTheme} is a PURE function (no DOM) and is the target of the
 * optional Property 42 test (task 8.3). Its load-bearing invariant: for the
 * gameplay play-area surface it returns `'gameplay'` and NEVER `'premium'`,
 * regardless of Round state.
 */

import type { RoundState } from '@glitch/core';

/**
 * The two deliberately-opposed art directions (design.md "Overview").
 * - `'premium'`  — the Premium_Entry_Surface aesthetic (Requirement 18.1).
 * - `'gameplay'` — the handmade zine/VHS/ransom-note aesthetic (Requirement 12).
 */
export type Theme = 'premium' | 'gameplay';

/**
 * A Client surface, distinguishing the in-round gameplay play area from the
 * non-gameplay Premium_Entry_Surfaces (design.md "Overview", Requirement 18.1).
 *
 * - `'landing'`     — the Landing_Page (premium).
 * - `'lobby'`       — the Lobby (premium).
 * - `'song_picker'` — the Song_Picker (premium).
 * - `'gameplay'`    — the in-round gameplay play area (handmade aesthetic).
 */
export type Surface = 'landing' | 'lobby' | 'song_picker' | 'gameplay';

/**
 * Select the art-direction {@link Theme} for a given {@link Surface}.
 *
 * The gameplay play area ALWAYS resolves to the handmade `'gameplay'` theme and
 * is NEVER assigned the `'premium'` theme — the invariant enforced by
 * Requirements 18.3 and 18.4 and checked by Property 42. The Round state is
 * accepted for completeness (the play area renders the handmade aesthetic while
 * playing per 18.4) but cannot change the gameplay surface's theme: the two
 * aesthetics never bleed into each other.
 *
 * Non-gameplay entry surfaces (Landing_Page, Lobby, Song_Picker) resolve to the
 * `'premium'` theme (Requirement 18.1).
 *
 * Implemented as an exhaustive switch so that adding a new {@link Surface}
 * without classifying it becomes a compile-time error (the `never` guard).
 *
 * @param surface - The surface being rendered.
 * @param _roundState - The current Round state (accepted for completeness; does
 *   not affect the gameplay surface's theme).
 * @returns `'gameplay'` for the gameplay play area, `'premium'` otherwise.
 */
export function selectTheme(surface: Surface, _roundState?: RoundState): Theme {
  switch (surface) {
    case 'gameplay':
      // Requirements 18.3 / 18.4: the in-round play area is always handmade,
      // never premium — independent of Round state.
      return 'gameplay';
    case 'landing':
    case 'lobby':
    case 'song_picker':
      // Premium_Entry_Surfaces (Requirement 18.1).
      return 'premium';
    default: {
      // Exhaustiveness guard: any future Surface must be classified above.
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}
