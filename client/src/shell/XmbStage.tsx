/**
 * `XmbStage` — the PSP / XMB-styled backdrop for Premium_Entry_Surfaces.
 *
 * Wraps a premium (non-gameplay) surface — Landing_Page, Lobby, Scorecard — in
 * the PlayStation Portable XrossMediaBar look: a deep blue→black gradient with
 * slow flowing wave ribbons and a sweeping cursor glow (all defined in
 * `index.css`). This is a restyle of the PREMIUM art direction ONLY; it is never
 * applied to the in-round gameplay play area (Requirements 18.3/18.4), which the
 * Renderer paints in the handmade aesthetic.
 *
 * Reduce-motion (Requirements 13.1/13.3): when `reduceMotion` is true the stage
 * adds the `xmb--still` class, which freezes every XMB animation via CSS. The
 * OS-level `prefers-reduced-motion` query also freezes them independently.
 */

import type { ReactNode } from 'react';

/** Props for {@link XmbStage}. */
export interface XmbStageProps {
  /** The premium surface content rendered above the XMB backdrop. */
  children: ReactNode;
  /** When true, freeze all XMB background motion (Requirement 13.1). */
  reduceMotion: boolean;
  /** Extra classes for the stage root (layout/spacing for the surface). */
  className?: string;
}

/**
 * Full-bleed XMB backdrop with the animated wave layers and cursor glow behind
 * `children`. The waves/glow are pure CSS pseudo-elements + an absolutely
 * positioned glow div, so they cost nothing in React render and sit behind the
 * content via z-index.
 */
export function XmbStage({ children, reduceMotion, className }: XmbStageProps) {
  const cls = ['xmb-stage', reduceMotion ? 'xmb--still' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <div className="xmb-glow" aria-hidden="true" />
      {children}
    </div>
  );
}

export default XmbStage;
