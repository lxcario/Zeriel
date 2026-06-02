/**
 * Reduce_Motion_Mode toggle — a labeled control on a Premium_Entry_Surface
 * (task 14.1).
 *
 * Design references:
 * - Requirement 13.3: provide a user control to toggle Reduce_Motion_Mode, and
 *   PERSIST + respect an explicit choice on subsequent visits rather than
 *   overriding it from the browser setting.
 * - Requirement 18.2: the toggle lives on a premium surface (the Lobby here).
 * - Requirement 13.5: labeled control with semantic markup outside the Canvas.
 *
 * The control is a native `<button role="switch">` with `aria-checked`, so it is
 * keyboard-operable and announced correctly by assistive tech. Toggling calls
 * {@link saveExplicitChoice} (Requirement 13.3 persistence) and lifts the new
 * value to the parent, which re-derives the effective setting.
 */

import { saveExplicitChoice } from '../theme/index.ts';

/** Props for {@link ReduceMotionToggle}. */
export interface ReduceMotionToggleProps {
  /** The current effective Reduce_Motion_Mode value. */
  enabled: boolean;
  /** Called with the new value after the user toggles (already persisted). */
  onChange: (enabled: boolean) => void;
}

/**
 * A persisted Reduce_Motion_Mode switch. On toggle it persists the explicit
 * choice (Requirement 13.3) and notifies the parent so the whole shell — the
 * gameplay Renderer and any ScrollReveal — picks up the new setting.
 */
export function ReduceMotionToggle({ enabled, onChange }: ReduceMotionToggleProps) {
  const handleToggle = () => {
    const next = !enabled;
    saveExplicitChoice(next); // Requirement 13.3: persist the explicit choice.
    onChange(next);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <span id="reduce-motion-label" className="text-sm font-medium text-neutral-200">
        Reduce motion
        <span className="block text-xs font-normal text-neutral-400">
          Minimizes non-essential motion and visual instability.
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby="reduce-motion-label"
        onClick={handleToggle}
        className={[
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400/60',
          enabled ? 'bg-indigo-500' : 'bg-neutral-700',
        ].join(' ')}
      >
        <span className="sr-only">Toggle reduce motion</span>
        <span
          aria-hidden="true"
          className={[
            'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
            enabled ? 'translate-x-5' : 'translate-x-0.5',
          ].join(' ')}
        />
      </button>
    </div>
  );
}

export default ReduceMotionToggle;
