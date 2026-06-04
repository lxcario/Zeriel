/**
 * `XmbBar` — the PSP XrossMediaBar category strip.
 *
 * A horizontal row of glossy icon tiles with one active (glowing, gently
 * bobbing) tile, evoking the PlayStation Portable home menu. Decorative
 * navigation furniture for the premium surfaces; clicking a tile fires
 * `onSelect` so it can drive simple in-page navigation, but it carries no
 * gameplay state. Motion (the active-tile bob) is frozen under reduce-motion.
 */

/** One XMB category tile. */
export interface XmbCategory {
  /** Stable id for the category. */
  id: string;
  /** Single-glyph icon (emoji or symbol) shown in the tile. */
  icon: string;
  /** Accessible label / caption for the category. */
  label: string;
}

/** Props for {@link XmbBar}. */
export interface XmbBarProps {
  /** Categories to render, left to right. */
  categories: readonly XmbCategory[];
  /** Id of the currently active (highlighted) category. */
  activeId: string;
  /** Freeze the active-tile bob animation (Requirement 13.1). */
  reduceMotion?: boolean;
  /** Fired when a tile is activated (click/Enter). */
  onSelect?: (id: string) => void;
}

/**
 * Render the XMB category strip with the active tile highlighted. The active
 * tile's caption is shown beneath the row, mirroring the PSP menu.
 */
export function XmbBar({ categories, activeId, reduceMotion = false, onSelect }: XmbBarProps) {
  const active = categories.find((c) => c.id === activeId) ?? categories[0];
  return (
    <nav aria-label="Menu categories" className="flex flex-col items-center gap-2">
      <ul className="xmb-bar list-none p-0">
        {categories.map((cat) => {
          const isActive = cat.id === active?.id;
          return (
            <li key={cat.id}>
              <button
                type="button"
                aria-label={cat.label}
                aria-current={isActive ? 'true' : undefined}
                data-active={isActive ? 'true' : 'false'}
                className={['xmb-icon', reduceMotion ? 'xmb--no-bob' : ''].filter(Boolean).join(' ')}
                onClick={() => onSelect?.(cat.id)}
              >
                <span aria-hidden="true">{cat.icon}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {active && (
        <p className="text-xs font-medium uppercase tracking-[0.25em] text-sky-200/80">
          {active.label}
        </p>
      )}
    </nav>
  );
}

export default XmbBar;
