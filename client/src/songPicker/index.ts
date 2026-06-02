/**
 * Barrel for the Song_Picker module (task 10.1).
 *
 * Re-exports the framework-agnostic controller (the testable `SongPicker`
 * contract logic), the injectable search backend, and the React view so
 * consumers (the UI shell in task 14.1, and the property tests in 10.2–10.5)
 * can import from a single entry point.
 */

export {
  SongPickerController,
  createSongPickerController,
  canControl,
  type ModeContext,
  type SongPickerState,
  type SongPickerControllerOptions,
} from './songPickerController.ts';

export {
  createPipedSearchBackend,
  mapPipedSearchResponse,
  extractVideoId,
  type SearchBackend,
  type SongSearchResult,
  type PipedSearchItem,
  type PipedSearchResponse,
  type PipedSearchBackendOptions,
} from './searchBackend.ts';

export { SongPicker, default as SongPickerView, type SongPickerProps } from './SongPicker.tsx';
