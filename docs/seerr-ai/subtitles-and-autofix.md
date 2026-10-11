# Subtitles and fixing problems

[← Seerr AI guide](./README.md)

## Subtitles

With Bazarr connected (**Settings → Services → Bazarr**), title pages have a **Subtitles** panel and each episode a subtitle tag, read from Bazarr, with where each subtitle came from.

- **Everyone** can see them, and set their own default subtitle in Plex.
- **Request managers** can search the providers, use a result (download or replace), and search for whatever is missing.
- **Transcribe**: when no provider has a subtitle, request managers can have Bazarr's WhisperAI provider make one, for the missing episodes, one season, or everything. Jobs run one at a time. If Bazarr has paused WhisperAI after an error (often because Whisper is busy), **Transcribe** says so, and the Health page shows it.
- Only admins can delete subtitle files.

Switch: `subtitles`.

## Auto-fix

When someone reports a problem, as an issue or in AI Search, Seerr AI tries to fix it and writes each step on the issue ("Automatic fix: …"):

- **Subtitles** missing or wrong: searched for, or transcribed.
- **Episodes or a movie missing**: searched for by Sonarr or Radarr, then Backfill, then the admin agent if it steps in on its own.
- **A broken file or the wrong episode**: a replacement is looked for, and the file is removed only once one is found. The same title is replaced at most once a day. From AI Search, these are filed as an issue and need permission to report issues.

People who aren't admins are limited to 30 fixes, and 10 file replacements, a day.

Switch: `autoFix`.
