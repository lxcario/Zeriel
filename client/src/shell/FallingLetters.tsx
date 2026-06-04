/**
 * `FallingLetters` — decorative ransom-note tiles drifting down the hero.
 *
 * Teases the in-round signature look (white paper scraps, dark ink glyphs,
 * slight tilt) on the premium Landing surface WITHOUT running the real physics
 * engine — it is pure CSS animation. Deterministic layout (seeded by index) so
 * it does not reflow between renders. Motion is frozen under reduce-motion via
 * the CSS rules in `index.css` (`.xmb--still` + the OS media query).
 */

import { useMemo } from 'react';

/** Props for {@link FallingLetters}. */
export interface FallingLettersProps {
  /** Words/letters to scatter as falling tiles. */
  tokens?: readonly string[];
  /** How many tiles to render (cycles through `tokens`). */
  count?: number;
}

/** Default scatter of short, song-like word fragments. */
const DEFAULT_TOKENS = [
  'la', 'oh', 'Waka', 'time', 'eh', 'World', 'na', 'love', 'Cup', 'yeah',
  'mina', 'dance', 'hey', 'fire', 'go', 'light', 'up', 'now', 'sing', 'beat',
];

/** Tiny deterministic hash → float in [0,1) so tile layout is stable per index. */
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A field of CSS-animated ransom-note tiles spread across the hero width, each
 * with a deterministic horizontal position, fall duration, delay, and tilt.
 */
export function FallingLetters({ tokens = DEFAULT_TOKENS, count = 16 }: FallingLettersProps) {
  const tiles = useMemo(() => {
    return Array.from({ length: count }, (_, i) => {
      const left = rand(i + 1) * 96; // 0..96% across
      const duration = 9 + rand(i + 7) * 9; // 9..18s fall
      const delay = -rand(i + 13) * 18; // negative → staggered, already mid-fall
      const rot = (rand(i + 23) * 2 - 1) * 10; // -10..10deg
      const token = tokens[i % tokens.length] ?? 'la';
      return { i, left, duration, delay, rot, token };
    });
  }, [tokens, count]);

  return (
    <div className="zl-falling" aria-hidden="true">
      {tiles.map((t) => (
        <span
          key={t.i}
          className="zl-tile"
          style={{
            left: `${t.left}%`,
            animationDuration: `${t.duration}s`,
            animationDelay: `${t.delay}s`,
            // CSS custom prop consumed by the @keyframes rotation.
            ['--rot' as string]: `${t.rot}deg`,
          }}
        >
          {t.token}
        </span>
      ))}
    </div>
  );
}

export default FallingLetters;
