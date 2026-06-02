import { CORE_PACKAGE } from '@glitch/core';

/**
 * Scaffolding-only app shell. Routing and the Premium_Entry_Surfaces
 * (Landing_Page, Lobby, Song_Picker) are implemented in later tasks.
 */
export default function App() {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Zeriel</h1>
        <p className="mt-2 text-neutral-400">
          live imperfect karaoke — scaffold ready ({CORE_PACKAGE})
        </p>
      </div>
    </main>
  );
}
