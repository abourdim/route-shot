# audio/library/

Background music tracks for the video exporter. Drop MP3/WAV files here — the
dashboard picks them up automatically (GET /api/audio/list populates the
"🎵 Audio" dropdown in the video panel).

## Not committed to git

This folder is gitignored except for this README. Audio binaries bloat the
repo and have licensing implications that are nobody's problem but yours.

## Where to get tracks (free, commercial-safe)

| Source | License | Attribution? | URL |
|---|---|---|---|
| **Pixabay Music** | Pixabay License (CC0-equivalent) | ❌ none | <https://pixabay.com/music/> |
| YouTube Audio Library | YouTube free license | ❌ none | <https://studio.youtube.com/channel/UC/music> |
| Free Music Archive | CC BY / CC0 (varies) | ⚠ check per track | <https://freemusicarchive.org/> |
| Uppbeat free tier | Uppbeat free | ❌ on free tier | <https://uppbeat.io/> |
| Incompetech (Kevin MacLeod) | CC BY 4.0 | ✅ **required** | <https://incompetech.com/music/> |

## Easy path — Pixabay

1. Visit <https://pixabay.com/music/>
2. Search for a vibe (ambient / cinematic / upbeat / lo-fi / tech / cyberpunk)
3. Click a track → **Download** button (no login required)
4. Save the MP3 into this folder with a descriptive name, e.g.:
   - `ambient-tech.mp3`
   - `upbeat-startup.mp3`
   - `cinematic-epic.mp3`
   - `chill-lofi.mp3`
   - `cyberpunk-synth.mp3`
   - `space-ambient.mp3`

Reload the dashboard — the dropdown picks them up automatically.

## Also supported

- **audio/uploads/** — files you upload via the dashboard's drag-and-drop
  (future feature; for now, drop files here yourself)
- **Paste a URL** in the dashboard's "Audio URL" field — the server downloads
  and caches the file in `audio/cache/` on first use.

## Licensing reminders

Free does not mean unlicensed. **Confirm the license of every track you use**,
especially if you publish the resulting video commercially or to YouTube.
CC BY tracks require crediting the artist (name + track title + link) in your
video description or end card.
