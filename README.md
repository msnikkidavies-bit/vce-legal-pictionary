# VCE Legal Studies Pictionary (Units 3–4) — Browser-Based MVP

This is a minimal, classroom-safe Pictionary-style **browser** app built with **Express** and **Socket.IO** (no build step). It supports a teacher host and up to 30 students per room, a 30s timer, fuzzy guess matching, profanity filter, scoring, and topic filters for Units 3/4 Areas of Study.

## Quick Start

1. Install Node.js 18+.
2. Unzip this folder.
3. In the project directory, run:
   ```bash
   npm install
   npm start
   ```
4. Open http://localhost:3000 in a desktop browser.

- Teacher: click “Create Room” (a 6-char code is generated). Configure topic filters and optional auto-end after N rounds.
- Students: go to the same URL, click “Join Room” and enter the **room code** + **first name**.
- Teacher starts the game when ready.

> **Terms list:** By default, a small sample list is loaded. In the teacher host panel, click **“Manage Terms”** and **paste your JSON** (following the format shown) to replace the session’s terms. Terms are **session-only** and not persisted.

## Session-only & Privacy
- No login, no analytics, no persistent storage. All state is in memory and lost when the server restarts or the game stops.

## Notes
- Drawer is never selected two rounds in a row.
- 30-second fixed rounds. First correct guess locks the round and shows the term to all.
- Points awarded to the drawer and first correct guesser equals **whole seconds remaining**.
- Guess matching is case-insensitive, tolerant to near-misses (Levenshtein).
- Profanity is filtered; spam guesses are throttled.
- Students never see which topic the term came from.
- Mini-canvas with pen/eraser/clear and a 6-color palette.

## Terms JSON Format

```json
[
  {
    "id": "uuid-1",
    "term": "presumption of innocence",
    "topicTags": ["U3AOS1", "U3"],
    "aliases": ["innocent until proven guilty"]
  }
]
```

Valid topic tags: `U3AOS1`, `U3AOS2`, `U3`, `U4AOS1`, `U4AOS2`, `U4`.

