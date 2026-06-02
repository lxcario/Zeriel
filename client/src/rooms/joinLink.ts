/**
 * Join-link build and parse (task 16.7).
 *
 * Design references:
 * - Requirement 1.2: WHEN a Room is created, THE Client SHALL display a
 *   shareable join link that contains the Room_Code.
 * - Requirement 1.4: IF a Player opens a join link whose Room_Code does not
 *   correspond to an existing Room, THEN THE Client SHALL display a "room not
 *   found" message and offer to create a new Room.
 * - design.md "Data Models": `RoomCode` is "short, URL-safe, collision-checked
 *   on creation"; the `join` message carries `roomCode`.
 * - design.md "Correctness Properties — Property 2 (Join-link round trip)":
 *   "For any Room_Code, parsing the join link built from that code yields back
 *   the original Room_Code." (Validated by the optional property test 16.8.)
 *
 * This module lives in the client package (not `@glitch/core`) because the join
 * link is a Client concern ("THE Client SHALL display a shareable join link").
 * It is nonetheless PURE and dependency-free: it uses only the WHATWG `URL` /
 * `URLSearchParams` APIs, which are available in both the browser and Node, so
 * it is fully testable without a DOM or a real `window.location`.
 *
 * ## Embedding scheme
 * The Room_Code is embedded as a query parameter: `{base}?room={CODE}`, e.g.
 * `https://glitch.example/?room=AB12CD`. Query-param embedding is chosen over a
 * path segment (`/join/CODE`) or a hash (`#room=CODE`) because:
 * - `URLSearchParams.set` / `.get` perform percent-encoding/decoding
 *   automatically, so the round trip is lossless for ANY string value — not
 *   only URL-safe Room_Codes — with no hand-rolled escaping.
 * - It composes cleanly with an existing base URL (origin + path) without
 *   assuming a particular client-side routing strategy.
 *
 * ## Boundary note re: Requirement 1.4 ("room not found")
 * This module decides only whether a link *contains* a Room_Code — it does NOT
 * decide whether that code corresponds to an existing Room. Room existence is
 * the Room Manager's responsibility (task 16.1): `RoomManager.joinRoom` returns
 * a `JoinResult` whose failure arm is `{ ok: false; reason: 'not_found' |
 * 'room_full' }` (see design.md). The two results compose:
 *   1. `parseJoinLinkResult(url)` → `no_code` (nothing to join) or a `roomCode`.
 *   2. With a `roomCode`, the caller asks the Room Manager to join; a
 *      `'not_found'` `JoinResult` is what drives the "room not found" UI for
 *      Requirement 1.4.
 * We deliberately do not duplicate the `'not_found'` / `'room_full'` literals
 * here so there is a single source of truth for room-existence outcomes.
 */

import type { RoomCode } from '@glitch/core';

/** Query-parameter name under which the Room_Code is embedded. */
export const JOIN_LINK_QUERY_PARAM = 'room';

/**
 * Fallback base URL used when no `baseUrl` is supplied and there is no usable
 * `globalThis.location` (e.g. server-side rendering or tests). The `.invalid`
 * TLD is reserved (RFC 6761) and guaranteed never to resolve, making it an
 * unambiguous placeholder; real deployments pass an explicit `baseUrl` or rely
 * on the browser's `location`.
 */
export const FALLBACK_BASE_URL = 'https://glitch.invalid/';

/**
 * Result of interpreting a URL as a join link (Requirement 1.4 boundary).
 *
 * - `{ ok: true; roomCode }`      — the link embeds a Room_Code.
 * - `{ ok: false; reason: 'no_code' }` — the URL carries no Room_Code (absent or
 *   empty `room` param), or the input was not a parseable URL.
 *
 * Note: `'no_code'` is intentionally distinct from the Room Manager's
 * `'not_found'` / `'room_full'` `JoinResult` reasons. Existence/capacity checks
 * are NOT performed here (see the module-level boundary note).
 */
export type JoinLinkResult =
  | { ok: true; roomCode: RoomCode }
  | { ok: false; reason: 'no_code' };

/**
 * Resolve the base URL to build a join link against. Prefers an explicit
 * `baseUrl`, then the current document location (guarded so this stays pure in
 * non-browser environments), then {@link FALLBACK_BASE_URL}.
 */
function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl !== undefined && baseUrl.length > 0) {
    return baseUrl;
  }
  const loc = (globalThis as { location?: { href?: unknown } }).location;
  if (loc && typeof loc.href === 'string' && loc.href.length > 0) {
    return loc.href;
  }
  return FALLBACK_BASE_URL;
}

/**
 * Build a shareable join link that embeds `roomCode` as the `room` query
 * parameter (Requirement 1.2).
 *
 * The code is encoded via `URLSearchParams`, so the round trip is lossless for
 * any string. Any pre-existing `room` parameter on the base URL is replaced;
 * other query parameters and the path are preserved.
 *
 * @param roomCode - The Room_Code to embed.
 * @param baseUrl  - Base URL to build against. Defaults to the current
 *   `globalThis.location` when present, otherwise {@link FALLBACK_BASE_URL}.
 *   Injectable so the function is deterministic and DOM-free in tests.
 * @returns The absolute join-link URL string.
 */
export function buildJoinLink(roomCode: RoomCode, baseUrl?: string): string {
  const url = new URL(resolveBaseUrl(baseUrl));
  url.searchParams.set(JOIN_LINK_QUERY_PARAM, roomCode);
  return url.toString();
}

/**
 * Parse a join link built by {@link buildJoinLink} and extract its Room_Code.
 *
 * Satisfies Property 2 (Requirement 1.2): for any non-empty Room_Code,
 * `parseJoinLink(buildJoinLink(code)) === code`.
 *
 * Returns `null` when the URL carries no Room_Code — that is, when the `room`
 * parameter is absent or empty — or when `url` is not a parseable URL. An empty
 * `room` value is treated as "no code" rather than as the empty-string code,
 * because an empty string is not a valid (collision-checked, URL-safe)
 * Room_Code; the round-trip guarantee therefore covers all valid codes.
 *
 * Relative URLs are tolerated by resolving them against
 * {@link FALLBACK_BASE_URL}, since only the query string is inspected.
 *
 * @param url - A join-link URL string (absolute, or relative to the fallback base).
 * @returns The embedded Room_Code, or `null` if none is present.
 */
export function parseJoinLink(url: string): RoomCode | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    try {
      parsed = new URL(url, FALLBACK_BASE_URL);
    } catch {
      return null;
    }
  }
  const code = parsed.searchParams.get(JOIN_LINK_QUERY_PARAM);
  if (code === null || code.length === 0) {
    return null;
  }
  return code;
}

/**
 * Interpret a URL as a join link and return a typed {@link JoinLinkResult}.
 *
 * This is the parse-side composition point for Requirement 1.4: a `no_code`
 * result means there is nothing to join, while an `ok` result yields a
 * `roomCode` the caller hands to the Room Manager — whose `'not_found'`
 * `JoinResult` then drives the "room not found" UI (see the module-level
 * boundary note). Room existence is NOT checked here.
 *
 * @param url - A join-link URL string.
 */
export function parseJoinLinkResult(url: string): JoinLinkResult {
  const roomCode = parseJoinLink(url);
  if (roomCode === null) {
    return { ok: false, reason: 'no_code' };
  }
  return { ok: true, roomCode };
}
