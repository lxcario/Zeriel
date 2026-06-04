/**
 * Landing_Page — a Premium_Entry_Surface (task 14.1).
 *
 * Design references:
 * - Requirement 18.1: present the Landing_Page with a clean layout, refined
 *   typography, and a dark premium color palette.
 * - Requirement 18.2: premium aesthetic, visually distinct from gameplay.
 * - Requirement 13.4: body-text contrast ≥ 4.5:1 (light text on a near-black
 *   background — neutral-200/300 on neutral-950 well exceeds 4.5:1).
 * - Requirement 13.5: semantic HTML headings (`<h1>`/`<h2>`) and labeled
 *   controls.
 * - Requirement 19.3: the Scroll_Reveal_Animation is used on this scroll-based
 *   non-gameplay surface (via {@link HeadlineReveal}), never for gameplay (19.4).
 *
 * Product display name is "Zeriel" (never "Glitch").
 */

import HeadlineReveal from './HeadlineReveal.tsx';
import XmbStage from './XmbStage.tsx';

/** Props for {@link LandingPage}. */
export interface LandingPageProps {
  /** Enter the Lobby to pick a song and play (single-player). */
  onStart: () => void;
  /** Effective Reduce_Motion_Mode (drives the headline reveal, Requirement 19.6). */
  reduceMotion: boolean;
}

/**
 * The marketing entry surface. A clean dark hero with the product name, a
 * scroll-revealed tagline, a primary call-to-action into the Lobby, and a brief
 * "how it works" section — all in the premium aesthetic.
 */
export function LandingPage({ onStart, reduceMotion }: LandingPageProps) {
  return (
    <XmbStage reduceMotion={reduceMotion} className="text-neutral-100">
      <section
        aria-labelledby="landing-title"
        className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center px-6 py-20 text-center"
      >
        <p className="mb-4 text-sm font-medium uppercase tracking-[0.3em] text-sky-300">
          Live imperfect karaoke
        </p>
        <h1
          id="landing-title"
          className="xmb-title text-6xl font-bold tracking-tight text-white sm:text-7xl"
        >
          Zeriel
        </h1>
        <div className="mt-6 max-w-2xl text-lg leading-relaxed text-sky-100/90">
          <HeadlineReveal
            reduceMotion={reduceMotion}
            baseOpacity={0.15}
            baseRotation={2}
            blurStrength={5}
          >
            Lyrics fall. You grab the words and drag them into order before the next
            line drops. Beautifully chaotic, endlessly replayable.
          </HeadlineReveal>
        </div>
        <div className="mt-10">
          <button
            type="button"
            onClick={onStart}
            className="xmb-button inline-flex items-center justify-center rounded-full px-8 py-3.5 text-base font-semibold text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70"
          >
            Start playing
          </button>
        </div>
        <p className="mt-4 text-sm text-sky-200/70">
          No account, no install. Jump straight into a single-player round.
        </p>
      </section>

      <section
        aria-labelledby="how-it-works-title"
        className="mx-auto max-w-5xl px-6 pb-24"
      >
        <h2
          id="how-it-works-title"
          className="xmb-title mb-10 text-center text-3xl font-semibold tracking-tight text-white"
        >
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {[
            {
              step: '1',
              title: 'Pick a song',
              body: 'Search for a track and queue it up for the round.',
            },
            {
              step: '2',
              title: 'Catch the words',
              body: 'Time-synced lyrics tumble down as physics-driven letters.',
            },
            {
              step: '3',
              title: 'Score and share',
              body: 'Order the words, get scored, and export a shareable card.',
            },
          ].map((item) => (
            <li key={item.step} className="xmb-panel p-6">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sky-400/25 text-base font-semibold text-sky-100 ring-1 ring-sky-300/40">
                {item.step}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-sky-100/80">{item.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </XmbStage>
  );
}

export default LandingPage;
