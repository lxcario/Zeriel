/**
 * Landing_Page — a Premium_Entry_Surface (task 14.1).
 *
 * Design references:
 * - Requirement 18.1: present the Landing_Page with a clean layout, refined
 *   typography, and a dark premium color palette.
 * - Requirement 18.2: premium aesthetic, visually distinct from gameplay.
 * - Requirement 13.4: body-text contrast ≥ 4.5:1 (light text on a near-black
 *   background).
 * - Requirement 13.5: semantic HTML headings (`<h1>`/`<h2>`/`<h3>`) and labeled
 *   controls.
 * - Requirement 19.3: the Scroll_Reveal_Animation is used on this scroll-based
 *   non-gameplay surface (via {@link HeadlineReveal}), never for gameplay (19.4).
 *
 * The hero teases the in-round signature look with decorative falling
 * ransom-note tiles ({@link FallingLetters}) behind a glossy "now playing"
 * preview card, so the entry surface shows what the game IS rather than empty
 * centered text. Product display name is "Zeriel" (never "Glitch").
 */

import HeadlineReveal from './HeadlineReveal.tsx';
import XmbStage from './XmbStage.tsx';
import XmbBar, { type XmbCategory } from './XmbBar.tsx';
import FallingLetters from './FallingLetters.tsx';

/** Props for {@link LandingPage}. */
export interface LandingPageProps {
  /** Enter the Lobby to pick a song and play (single-player). */
  onStart: () => void;
  /** Effective Reduce_Motion_Mode (drives the headline reveal, Requirement 19.6). */
  reduceMotion: boolean;
}

/** Decorative XMB category strip across the top of the landing surface. */
const XMB_CATEGORIES: readonly XmbCategory[] = [
  { id: 'play', icon: '▶', label: 'Play' },
  { id: 'music', icon: '♪', label: 'Music' },
  { id: 'rooms', icon: '⌂', label: 'Rooms' },
  { id: 'cards', icon: '★', label: 'Scorecards' },
];

/** Three quick "feature" highlights shown beneath the hero. */
const FEATURES: ReadonlyArray<{ icon: string; title: string; body: string }> = [
  {
    icon: '🎤',
    title: 'Real songs, real lyrics',
    body: 'Search any track. Time-synced lyrics drop in beat with the music.',
  },
  {
    icon: '🧲',
    title: 'Physics you can grab',
    body: 'Letters tumble as rope-physics tiles. Drag them into order before the line clears.',
  },
  {
    icon: '📸',
    title: 'A card worth sharing',
    body: 'Every round ends with a scorecard image built to screenshot and post.',
  },
];

/** The marketing entry surface: a teaser hero, how-it-works, and a closing CTA. */
export function LandingPage({ onStart, reduceMotion }: LandingPageProps) {
  return (
    <XmbStage reduceMotion={reduceMotion} className="text-neutral-100">
      {/* ---- Top bar ---- */}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-6">
        <span className="xmb-title text-xl font-bold tracking-tight text-white">Zeriel</span>
        <XmbBar categories={XMB_CATEGORIES} activeId="play" reduceMotion={reduceMotion} />
        <button
          type="button"
          onClick={onStart}
          className="hidden rounded-full border border-sky-300/30 px-4 py-1.5 text-sm font-medium text-sky-100 transition-colors hover:border-sky-300/60 hover:bg-sky-400/10 sm:inline-flex"
        >
          Play now
        </button>
      </div>

      {/* ---- Hero ---- */}
      <section
        aria-labelledby="landing-title"
        className="zl-hero mx-auto grid min-h-[78vh] max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-2"
      >
        <FallingLetters />

        {/* Left: headline + CTA */}
        <div className="text-center lg:text-left">
          <p className="mb-4 text-sm font-medium uppercase tracking-[0.3em] text-sky-300">
            Live imperfect karaoke
          </p>
          <h1
            id="landing-title"
            className="xmb-title text-6xl font-bold leading-[0.95] tracking-tight text-white sm:text-7xl"
          >
            Catch the<br />
            <span className="bg-gradient-to-r from-sky-300 to-indigo-300 bg-clip-text text-transparent">
              falling lyrics
            </span>
          </h1>
          <div className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-sky-100/90 lg:mx-0">
            <HeadlineReveal
              reduceMotion={reduceMotion}
              baseOpacity={0.15}
              baseRotation={2}
              blurStrength={5}
            >
              A song plays, its words tumble down, and you drag them into order before the
              next line drops. Chaotic, fast, and endlessly replayable.
            </HeadlineReveal>
          </div>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
            <button
              type="button"
              onClick={onStart}
              className="xmb-button inline-flex w-full items-center justify-center rounded-full px-8 py-3.5 text-base font-semibold text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70 sm:w-auto"
            >
              Start playing
            </button>
            <span className="text-sm text-sky-200/70">No account · No install · Free</span>
          </div>
        </div>

        {/* Right: glossy "now playing" mock card */}
        <div className="xmb-panel mx-auto w-full max-w-md p-6" aria-hidden="true">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400/40 to-indigo-500/40 text-3xl ring-1 ring-sky-300/40">
              ♪
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-white">Now playing</p>
              <p className="truncate text-sm text-sky-200/70">Your pick · Single-player round</p>
            </div>
          </div>
          <div className="zl-preview-bar mt-5">
            <span />
          </div>
          <div className="mt-2 flex justify-between text-xs tabular-nums text-sky-200/50">
            <span>0:42</span>
            <span>3:11</span>
          </div>
          {/* Mock answer row with a couple of placed/ghost tiles. */}
          <div className="mt-6 flex flex-wrap gap-2">
            {['Waka', 'Waka', 'eh', 'eh'].map((w, i) => (
              <span
                key={`${w}-${i}`}
                className={[
                  'rounded border-2 px-2 py-1 font-mono text-sm font-bold',
                  i < 2
                    ? 'border-[#141210] bg-[#f4efe1] text-[#141210]'
                    : 'border-dashed border-sky-300/40 text-sky-200/40',
                ].join(' ')}
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Feature highlights ---- */}
      <section aria-labelledby="features-title" className="mx-auto max-w-6xl px-6 pb-8">
        <h2 id="features-title" className="sr-only">
          What makes it fun
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="xmb-panel p-6">
              <span className="text-2xl" aria-hidden="true">
                {f.icon}
              </span>
              <h3 className="mt-3 text-lg font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-sky-100/80">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section aria-labelledby="how-it-works-title" className="mx-auto max-w-6xl px-6 pb-16">
        <h2
          id="how-it-works-title"
          className="xmb-title mb-10 text-center text-3xl font-semibold tracking-tight text-white"
        >
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {[
            { step: '1', title: 'Pick a song', body: 'Search for a track and queue it up for the round.' },
            { step: '2', title: 'Catch the words', body: 'Time-synced lyrics tumble down as physics-driven letters.' },
            { step: '3', title: 'Score and share', body: 'Order the words, get scored, and export a shareable card.' },
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

      {/* ---- Closing CTA ---- */}
      <section className="mx-auto max-w-3xl px-6 pb-24 text-center">
        <div className="xmb-panel px-8 py-12">
          <h2 className="xmb-title text-3xl font-bold tracking-tight text-white">
            Ready to play a round?
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sky-100/80">
            Pick a song and jump straight in. It takes about three minutes.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="xmb-button mt-7 inline-flex items-center justify-center rounded-full px-8 py-3.5 text-base font-semibold text-white transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-sky-300/70"
          >
            Start playing
          </button>
        </div>
        <p className="mt-8 text-xs text-sky-200/50">
          Zeriel · Live imperfect karaoke
        </p>
      </section>
    </XmbStage>
  );
}

export default LandingPage;
