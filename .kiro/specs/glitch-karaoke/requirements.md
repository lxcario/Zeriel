# Requirements Document

## Introduction

Glitch ("live imperfect karaoke") is a free, open-source, real-time multiplayer browser party game. A song plays while its time-synced lyrics fall from the top of the screen as physics-driven rope-letters that tumble, bounce, and pile up. Players in a shared room each grab different words or letters with their cursor and drag them into the correct order before the next lyric line drops. The experience is intentionally rough and "broken-looking" in its art direction (VHS colors, scan-lines, ransom-note cut-out letters, paper grain, off-grid placement) while the core interactions remain responsive and accurate.

Audio is resolved through the Piped API (a privacy-friendly YouTube frontend) with multi-instance fallback, and time-synced lyrics are retrieved from LRCLIB. Real-time multiplayer is driven by an authoritative server running a fixed physics tick at approximately 30Hz that owns ground-truth letter positions and enforces ownership locks, with client-side prediction and reconciliation for responsiveness. Rendering uses the 2D HTML5 Canvas with a Verlet particle/constraint physics model.

The product is built by a solo developer with AI assistance on an approximately two-week timeline. Scope is structured so that single-player works standalone first and multiplayer is an additive layer, ensuring the game still demos if multiplayer slips. Each round ends with a shareable, exportable scorecard image, which is treated as a first-class, core growth feature rather than polish.

## Glossary

- **Glitch**: The complete web application, comprising the Client, the Game_Server, and supporting service integrations.
- **Client**: The browser-side application responsible for rendering, local input, client-side physics prediction, and UI.
- **Game_Server**: The authoritative real-time server that owns ground-truth letter state, runs the fixed physics tick, enforces ownership locks, and broadcasts state to Clients.
- **Renderer**: The Client subsystem that draws the game and UI to the 2D HTML5 Canvas.
- **Physics_Engine**: The subsystem that advances Verlet particle positions and resolves distance constraints for rope-letters. It runs authoritatively on the Game_Server and as a prediction copy on the Client.
- **Audio_Resolver**: The subsystem that obtains a playable audio stream URL for a chosen track via the Piped API, including multi-instance fallback.
- **Audio_Player**: The Client subsystem that loads and plays resolved audio through the Web Audio API and exposes amplitude and frequency data.
- **Lyrics_Service**: The subsystem that retrieves time-synced lyrics from LRCLIB and parses them into timed lyric lines.
- **Song_Picker**: The Client UI subsystem for searching and selecting a track.
- **Room**: A shared game session identified by a unique Room_Code, joinable via a shared link.
- **Room_Code**: The unique identifier embedded in a shared join link used to enter a specific Room.
- **Host**: The Player who created the Room and holds round-control privileges.
- **Player**: A participant connected to a Room, identified by a session-scoped Player_Id and a display name.
- **Player_Id**: A session-scoped identifier assigned to a Player on connection, without requiring an account.
- **Cursor**: A Player's pointer position used to grab and drag rope-letters, shared as presence data.
- **Rope_Letter**: A single letter or word rendered as a chain of Verlet particles connected by distance constraints, subject to physics.
- **Lyric_Line**: A single timestamped line of lyrics that is dropped into play at its scheduled time.
- **Ownership_Lock**: A server-enforced exclusive claim on a Rope_Letter held by one Player at a time.
- **Solution_Slot**: A target position in the ordered answer area where a Rope_Letter must be placed to be counted as correctly ordered.
- **Round**: One lifecycle of play for a single song, from start to final scoring.
- **Scorecard**: The end-of-round summary, exportable as an image, showing the group's collective result.
- **Reduce_Motion_Mode**: A Client mode that minimizes non-essential motion and visual instability for accessibility.
- **Single_Player_Mode**: A mode in which one Player plays a Round locally without requiring multiplayer connectivity.
- **Piped_Instance**: One public Piped API endpoint used by the Audio_Resolver to resolve audio streams.
- **Landing_Page**: The marketing-oriented entry page presented before a Player creates or joins a Room, served as a scroll-based non-gameplay surface.
- **Lobby**: The pre-Round Room view where Players gather, view the roster, and await Round start, presented as a Premium_Entry_Surface.
- **Premium_Entry_Surface**: A non-gameplay Client surface presented with a polished, professional, Spotify-style art direction comprising a clean layout, refined typography, and a dark premium color palette, distinct from the in-round gameplay aesthetic.
- **Scroll_Reveal_Animation**: A scroll-scrubbed text reveal, based on the React Bits ScrollReveal component and driven by GSAP ScrollTrigger, that animates a string child word by word as the user scrolls.

## Requirements

### Requirement 1: Room Creation and Link-Based Joining

**User Story:** As a player, I want to create a room and share a link, so that friends can join and play together within seconds without any setup.

#### Acceptance Criteria

1. WHEN a Player requests a new Room, THE Game_Server SHALL create a Room with a unique Room_Code and designate that Player as the Host.
2. WHEN a Room is created, THE Client SHALL display a shareable join link that contains the Room_Code.
3. WHEN a Player opens a valid join link, THE Client SHALL connect the Player to the corresponding Room within 5 seconds under nominal network conditions.
4. IF a Player opens a join link whose Room_Code does not correspond to an existing Room, THEN THE Client SHALL display a "room not found" message and offer to create a new Room.
5. IF a Player attempts to join a Room that has reached its configured maximum Player count, THEN THE Game_Server SHALL reject the join and THE Client SHALL display a "room full" message.
6. THE Glitch SHALL allow a Player to create or join a Room without creating an account or installing software.

### Requirement 2: Player Identity and Presence

**User Story:** As a player, I want to see who else is in the room and where their cursors are, so that the shared play feels live and coordinated.

#### Acceptance Criteria

1. WHEN a Player connects to a Room, THE Game_Server SHALL assign a session-scoped Player_Id and admit the Player with a display name.
2. WHERE a Player has not provided a display name, THE Client SHALL assign a generated default display name before the Player enters the Room.
3. WHEN the set of Players in a Room changes, THE Game_Server SHALL broadcast the updated Player roster to all connected Clients within 1 second.
4. WHILE a Round is in progress, THE Game_Server SHALL broadcast each Player's Cursor position to all other Clients in the Room at a rate of at least 15 updates per second.
5. WHEN a Player disconnects, THE Game_Server SHALL release all Ownership_Locks held by that Player and remove the Player from the roster within 2 seconds.
6. IF a Player's connection drops and re-establishes within the reconnection window, THEN THE Game_Server SHALL restore the Player to the same Room with the same display name.

### Requirement 3: Song Selection and Search

**User Story:** As a host, I want to search for and pick a song through a familiar picker interface, so that I can quickly start a round with a track the group knows.

#### Acceptance Criteria

1. WHEN the Host enters a search query in the Song_Picker, THE Song_Picker SHALL display a list of matching track candidates including title and artist.
2. WHEN the Host selects a track candidate, THE Client SHALL record the selected track as the pending track for the next Round.
3. THE Song_Picker SHALL present its own art direction and SHALL NOT reproduce Spotify branding, logos, or trademarks.
4. IF a search query returns no matching candidates, THEN THE Song_Picker SHALL display a "no results" message and allow the Host to enter a new query only after the current search request completes.
5. WHILE a search request is pending, THE Song_Picker SHALL display a loading indicator and SHALL block submission of a new query until the current search completes.
6. WHERE the Glitch is running in Single_Player_Mode, THE Song_Picker SHALL allow the single Player to search for and select a track; WHERE the Glitch is running in multiplayer, THE Song_Picker SHALL restrict search and selection to the Host.

### Requirement 4: Audio Resolution with Multi-Instance Fallback

**User Story:** As a player, I want the chosen song's audio to load reliably, so that the round can play even though public audio sources are unreliable.

#### Acceptance Criteria

1. WHEN a track is selected for a Round, THE Audio_Resolver SHALL request a playable audio stream URL for that track from a Piped_Instance.
2. IF a Piped_Instance request fails, times out after 8 seconds, or returns no usable audioStreams, THEN THE Audio_Resolver SHALL retry the request against the next configured Piped_Instance.
3. THE Audio_Resolver SHALL attempt each configured Piped_Instance at most once per resolution attempt before reporting failure.
4. WHEN the Audio_Resolver obtains a usable audio stream URL, THE Audio_Resolver SHALL return the URL to the Audio_Player and SHALL NOT report an audio-resolution failure.
5. IF all configured Piped_Instances fail to resolve a usable audio stream URL AND no usable URL has been obtained, THEN THE Audio_Resolver SHALL report an audio-resolution failure and THE Client SHALL display a message offering the Host to select a different track.
6. WHILE audio resolution is in progress, THE Client SHALL display a resolving-audio status indicator.

### Requirement 5: Audio Playback and Reactive Analysis

**User Story:** As a player, I want the song to play in sync with the visuals and drive reactive effects, so that the game feels alive and tied to the music.

#### Acceptance Criteria

1. WHEN the Audio_Player receives a resolved audio stream URL, THE Audio_Player SHALL load the stream through the Web Audio API.
2. WHEN a Round starts, THE Audio_Player SHALL begin playback from the start of the track.
3. WHILE audio is playing, THE Audio_Player SHALL expose current amplitude and frequency data to the Renderer at the rendering frame rate.
4. IF the audio stream fails to load or playback stalls for a duration exceeding 5 seconds, THEN THE Audio_Player SHALL report a playback failure and THE Client SHALL offer the Host to retry resolution or select a different track.
5. THE Audio_Player SHALL expose the current playback time so that Lyric_Line scheduling can be aligned to the audio.

### Requirement 6: Synced Lyric Retrieval and Timing

**User Story:** As a player, I want lyrics to drop in time with the music, so that the words I order match what is being sung.

#### Acceptance Criteria

1. WHEN a track is selected for a Round, THE Lyrics_Service SHALL request time-synced lyrics for that track from LRCLIB using track metadata.
2. WHEN LRCLIB returns synced lyrics, THE Lyrics_Service SHALL parse the response into an ordered set of Lyric_Lines, each with a start timestamp and text.
3. WHILE a Round is in progress, THE Game_Server SHALL schedule each Lyric_Line to drop into play at its start timestamp relative to the audio playback time.
4. IF LRCLIB returns no synced lyrics matching the selected track, THEN THE Lyrics_Service SHALL report a no-lyrics result and THE Client SHALL offer the Host to select a different track or continue in a lyrics-free listening state.
5. IF the Lyrics_Service request fails or times out after 8 seconds, THEN THE Lyrics_Service SHALL report a lyrics-retrieval failure and THE Client SHALL display a retrievable error state with a retry option.

### Requirement 7: Falling Physics Rope-Letters

**User Story:** As a player, I want lyric letters to fall and tumble with believable physics, so that the play feels tactile and chaotic in a controlled way.

#### Acceptance Criteria

1. WHEN a Lyric_Line drops, THE Physics_Engine SHALL spawn a Rope_Letter for each letter or word in the Lyric_Line at the top of the play area.
2. THE Physics_Engine SHALL advance Rope_Letter positions using Verlet integration on a fixed timestep that is decoupled from the Renderer frame rate.
3. THE Physics_Engine SHALL maintain each Rope_Letter as a chain of particles connected by distance constraints whose rest lengths are preserved within a configured tolerance after constraint resolution.
4. WHILE Rope_Letters are in the play area, THE Physics_Engine SHALL constrain Rope_Letter particles to remain within the play-area bounds.
5. WHEN two Rope_Letters occupy overlapping space, THE Physics_Engine SHALL resolve their positions so that they come to rest in a stacked or piled arrangement rather than passing through each other.
6. THE Game_Server SHALL own the ground-truth positions of all Rope_Letters during a multiplayer Round.

### Requirement 8: Word Grabbing with Ownership Locks

**User Story:** As a player, I want to grab and drag a word that no one else can grab at the same time, so that multiple players can work without fighting over the same piece.

#### Acceptance Criteria

1. WHEN a Player initiates a grab on an unlocked Rope_Letter, THE Game_Server SHALL assign an Ownership_Lock on that Rope_Letter to the requesting Player.
2. IF a Player initiates a grab on a Rope_Letter that already holds an Ownership_Lock by another Player, THEN THE Game_Server SHALL deny the grab and THE Client SHALL indicate that the Rope_Letter is unavailable.
3. WHILE a Player holds an Ownership_Lock on a Rope_Letter, THE Physics_Engine SHALL move that Rope_Letter toward the owning Player's Cursor position.
4. WHEN a Player releases a grabbed Rope_Letter, THE Game_Server SHALL clear the Ownership_Lock on that Rope_Letter.
5. WHEN a Player initiates a grab AND the Client cannot already determine that the grab will fail, THE Client SHALL apply client-side prediction to begin moving the Rope_Letter locally before server confirmation.
6. WHERE the Client can determine in advance that a grab will fail, such as grabbing a visibly locked Rope_Letter, THE Client SHALL skip client-side prediction for that grab.
7. WHEN the Game_Server response differs from the Client's predicted grab outcome, including a locally denied grab that the Game_Server confirms, THE Client SHALL reconcile the predicted Rope_Letter state to the authoritative state.
8. IF a Player holding an Ownership_Lock disconnects, THEN THE Game_Server SHALL release that Ownership_Lock within 2 seconds.

### Requirement 9: Ordering and Scoring Logic

**User Story:** As a group of players, I want our arrangement of letters to be scored against the correct order, so that we get feedback on how well we did together.

#### Acceptance Criteria

1. THE Game_Server SHALL define a Solution_Slot sequence for each dropped Lyric_Line corresponding to the correct order of its Rope_Letters.
2. WHEN a Rope_Letter comes to rest within the position tolerance of a Solution_Slot, THE Game_Server SHALL mark that Rope_Letter as placed in that Solution_Slot.
3. WHILE a Lyric_Line's drop window is open, THE Game_Server SHALL update a provisional per-line score in real time as Rope_Letters are placed into matching Solution_Slots, and SHALL broadcast the provisional score to Clients.
4. WHEN a Lyric_Line's drop window closes, THE Game_Server SHALL finalize the per-line score equal to the count of Rope_Letters whose placed Solution_Slot matches the correct order.
5. THE Game_Server SHALL accumulate finalized per-line scores into a Round total score.
6. WHEN a Round ends, THE Game_Server SHALL produce a final Round result including the total score and per-Player contribution counts.
7. WHERE the Glitch is running in Single_Player_Mode, THE Game_Server logic SHALL compute scores using the same ordering rules applied to the single Player.

### Requirement 10: Round Lifecycle

**User Story:** As a host, I want clear control over starting and ending a round, so that the group plays in a coordinated sequence.

#### Acceptance Criteria

1. WHEN the Host starts a Round with a selected track whose audio and lyrics are resolved, THE Game_Server SHALL transition the Room to the playing state and notify all Clients.
2. WHILE a Round is in the playing state, THE Game_Server SHALL drop Lyric_Lines according to their scheduled timestamps until the last Lyric_Line is reached.
3. WHEN the last Lyric_Line's drop window closes or the audio track ends, THE Game_Server SHALL transition the Round to the scoring state.
4. WHEN the Round enters the scoring state, THE Game_Server SHALL finalize the Round result completely before notifying Clients to display the Scorecard.
5. IF the Host starts a Round before audio resolution and lyric retrieval have completed, THEN THE Game_Server SHALL reject the start and THE Client SHALL indicate that the track is not ready.
6. WHEN a Round has ended, THE Host SHALL be able to start a new Round with a newly selected track.

### Requirement 11: Shareable Scorecard Image Export

**User Story:** As a player, I want to export and share an image of our round result, so that I can post it and bring more people to the game.

#### Acceptance Criteria

1. WHEN a Round enters the scoring state, THE Client SHALL render a Scorecard that includes the track title, the group total score, and per-Player contributions.
2. WHEN a Player requests to export the Scorecard, THE Client SHALL generate a downloadable raster image of the Scorecard.
3. THE exported Scorecard image SHALL reflect the same visible content and art direction shown in the on-screen Scorecard.
4. THE Client SHALL provide a control to copy or download the exported Scorecard image.
5. IF Scorecard image generation fails, THEN THE Client SHALL allow the Player to retry the export, and MAY retry without requiring an error message to be displayed.
6. WHERE the Glitch is running in Single_Player_Mode, THE Client SHALL render and export a Scorecard for the single Player's Round result.

### Requirement 12: Handmade Aesthetic Art Direction

**User Story:** As a player, I want the game to feel like a handmade zine rather than a generic template, so that it feels authentic and distinct.

#### Acceptance Criteria

1. THE Renderer SHALL render Rope_Letters in a cut-out ransom-note letter style with per-letter variation in rotation and placement.
2. THE Renderer SHALL apply a scan-line overlay and a paper-grain texture over the play area.
3. THE Renderer SHALL apply off-grid placement so that UI and play elements deviate from strict alignment by a bounded random offset.
4. THE Renderer SHALL pre-render static textures, including paper grain, to an off-screen buffer once and stamp them during the main draw loop.
5. THE Renderer SHALL render neo-brutalist boundaries with thick borders and high-contrast color treatment for primary UI containers.

### Requirement 13: Accessibility Constraints

**User Story:** As a player with motion or contrast sensitivity, I want options to reduce instability and ensure readability, so that I can play comfortably.

#### Acceptance Criteria

1. WHERE Reduce_Motion_Mode is enabled, THE Renderer SHALL suppress non-essential motion effects, including scan-line jitter and decorative shake, while preserving core gameplay motion.
2. WHEN the Client detects a browser "prefers-reduced-motion" setting on first visit, THE Client SHALL enable Reduce_Motion_Mode by default.
3. THE Client SHALL provide a user control to toggle Reduce_Motion_Mode, and SHALL persist and respect an explicit Reduce_Motion_Mode choice on subsequent visits rather than overriding it from the browser setting.
4. THE Client SHALL render lyric and UI text such that text-to-background contrast meets a minimum ratio of 4.5:1 for body text.
5. THE Client SHALL provide semantic HTML headings and descriptive labels for interactive controls outside the Canvas play area.

### Requirement 14: Performance Targets

**User Story:** As a player, I want smooth, responsive play, so that grabbing and dragging never feels laggy or stuttery.

#### Acceptance Criteria

1. WHILE a Round is in the playing state with up to the configured maximum number of concurrent Rope_Letters, THE Renderer SHALL sustain a rendering frame rate of at least 60 frames per second on a reference mid-range device.
2. THE Physics_Engine SHALL run its simulation on a fixed timestep loop that is decoupled from the Renderer frame rate.
3. THE Physics_Engine and Renderer SHALL reuse pre-allocated vector and buffer objects within their loops rather than allocating new objects per frame.
4. WHEN a Player moves the Cursor while holding an Ownership_Lock AND client-side prediction is available, THE Client SHALL reflect the predicted Rope_Letter movement within 50 milliseconds locally.
5. WHERE client-side prediction is unavailable or disabled, THE Client SHALL reflect Rope_Letter movement based on authoritative Game_Server updates.
6. THE Game_Server SHALL run its authoritative Physics_Engine tick at an approximate rate of 30 ticks per second, and SHALL be permitted to vary around that rate as long as gameplay remains smooth.

### Requirement 15: Single-Player Baseline and Multiplayer Layering

**User Story:** As the developer, I want single-player to work standalone with multiplayer added on top, so that the game still demos if multiplayer is not finished.

#### Acceptance Criteria

1. THE Glitch SHALL support Single_Player_Mode in which one Player completes a full Round, including song selection, falling letters, grabbing, ordering, scoring, and Scorecard export, without a multiplayer connection.
2. WHERE multiplayer connectivity is unavailable, THE Client SHALL allow the Player to start and complete a Round in Single_Player_Mode.
3. THE ordering and scoring rules SHALL produce equivalent results for a given arrangement of Rope_Letters regardless of whether the Round runs in Single_Player_Mode or multiplayer.
4. WHEN multiplayer is enabled, THE Glitch SHALL add Room presence, Cursor sharing, and Ownership_Locks on top of the single-player gameplay without changing the core ordering and scoring rules.

### Requirement 16: Real-Time State Synchronization and Reconciliation

**User Story:** As a player in a room, I want everyone to see a consistent game state, so that what I do is reflected accurately for the whole group.

#### Acceptance Criteria

1. WHILE a multiplayer Round is in the playing state, THE Game_Server SHALL broadcast authoritative Rope_Letter positions and Ownership_Lock states to all Clients in the Room at a rate of at least 15 updates per second.
2. WHEN a Client receives an authoritative state update, THE Client SHALL reconcile its predicted state toward the authoritative state.
3. WHEN a Client joins a Round in progress, THE Game_Server SHALL send the current authoritative Round state so that the Client renders the same play state as existing Players.
4. WHEN a Client and the Game_Server disagree on a grabbed Rope_Letter's position, THE Client SHALL treat the Game_Server position as authoritative.
5. THE Client SHALL estimate its clock offset from the Game_Server during connection initialization so that local physics ticks align with the Game_Server timeline.

### Requirement 17: External API Error and Edge Handling

**User Story:** As a player, I want clear handling when external services fail, so that the game never silently breaks and I know what to do next.

#### Acceptance Criteria

1. IF an external service request to a Piped_Instance, LRCLIB, or a search backend fails, THEN THE Client SHALL display an actionable error message describing the failure and the available next step.
2. WHEN an external service request is initiated, THE Client SHALL apply a request timeout of at most 8 seconds, and SHALL terminate and treat as failed any request that exceeds the timeout.
3. IF audio is resolved but no matching synced lyrics are available, THEN THE Glitch SHALL allow the Host to continue in a lyrics-free listening state or select a different track.
4. IF lyrics are available but audio cannot be resolved after exhausting all Piped_Instances, THEN THE Client SHALL prevent starting a scored Round and offer the Host to select a different track.
5. WHEN a recoverable external service error is displayed, THE Client SHALL provide a retry control for the failed operation.

### Requirement 18: Premium Entry Surfaces

**User Story:** As a player arriving at the game, I want the landing page, lobby, and song picker to look polished and professional, so that the entry experience feels premium before the round deliberately turns chaotic.

#### Acceptance Criteria

1. THE Client SHALL present the Landing_Page, the Lobby, and the Song_Picker as Premium_Entry_Surfaces with a clean layout, refined typography, and a dark premium color palette.
2. THE Premium_Entry_Surface art direction SHALL be visually distinct from the in-round zine, VHS, and ransom-note gameplay aesthetic defined in Requirement 12.
3. THE Client SHALL NOT apply the Premium_Entry_Surface art direction to the in-round gameplay play area.
4. WHILE a Round is in the playing state, THE Renderer SHALL render the gameplay play area using the handmade aesthetic art direction defined in Requirement 12 rather than the Premium_Entry_Surface art direction.
5. THE Song_Picker Premium_Entry_Surface styling SHALL NOT reproduce Spotify branding, logos, or trademarks, consistent with Requirement 3 Acceptance Criterion 3.

### Requirement 19: Scroll-Driven Text Reveal (ScrollReveal)

**User Story:** As a visitor on a scroll-based entry surface, I want headline text to reveal word by word as I scroll, so that the premium entry experience feels engaging and intentional.

#### Acceptance Criteria

1. THE Client SHALL provide a Scroll_Reveal_Animation, based on the React Bits ScrollReveal component, that splits a string child into one span per word and animates the words with a configured stagger.
2. WHILE a Player scrolls a scroll-based non-gameplay surface containing a Scroll_Reveal_Animation, THE Client SHALL scrub each word's opacity from a configured base opacity to full opacity, scrub each word's blur from a configured blur strength to zero, and scrub the container rotation from a configured base rotation to zero, in proportion to scroll position via GSAP ScrollTrigger.
3. THE Client SHALL restrict use of the Scroll_Reveal_Animation to scroll-based non-gameplay surfaces, including the Landing_Page and an optional Scorecard reveal or how-to-play intro.
4. THE Client SHALL NOT use the Scroll_Reveal_Animation to drive the in-round falling lyric animation, which is audio-playback-time and physics driven per Requirement 6 and Requirement 7.
5. THE Scroll_Reveal_Animation SHALL expose configurable parameters for enabling or disabling blur, the base opacity, the base rotation, the blur strength, and the ScrollTrigger start and end points.
6. WHERE Reduce_Motion_Mode is enabled, THE Client SHALL suppress or reduce the Scroll_Reveal_Animation by rendering the text at full opacity with no blur and no rotation, consistent with Requirement 13.
7. THE Client SHALL include gsap with the ScrollTrigger plugin as a dependency to drive the Scroll_Reveal_Animation.
8. WHEN a component hosting a Scroll_Reveal_Animation unmounts, THE Client SHALL clean up the ScrollTrigger instances created for that Scroll_Reveal_Animation.
