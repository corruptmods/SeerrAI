# Subtitles and fixing problems

[← Seerr AI guide](./README.md)

## Subtitles

With Bazarr connected (**Settings → Services → Bazarr**), title pages have a **Subtitles** panel and each episode a subtitle tag, read from Bazarr, with where each subtitle came from.

- **Everyone** can see them, and with Plex set their own default subtitle.
- **Request managers** can search the providers, use a result (download or replace), and search for whatever is missing. Bazarr does the work; subtitles show on the page as they arrive.
- **Transcribe**: when no provider has a subtitle, request managers can have Bazarr's WhisperAI provider make one, for the missing episodes, one season, or everything: Whisper listens to each episode. Jobs run one at a time: each is followed in Bazarr until its subtitle is saved, and only then is the next asked for. While Bazarr has one waiting behind its own jobs, the page says so. If Bazarr restarts and loses one, it's asked for again. Each subtitle shows on the page when it's done. If Bazarr has paused WhisperAI after an error (often because Whisper is busy), **Transcribe** says so, and the Health page shows it.
- Only admins can delete subtitle files.

Switch: `subtitles`.

## Auto-fix

When someone reports a problem, as an issue, in AI Search or [with Siri](./siri.md), Seerr AI tries to fix it and writes each step on the issue ("Automatic fix: …"):

- **Subtitles** missing or wrong: searched for, or transcribed.
- **Episodes or a movie missing**: searched for by Sonarr or Radarr, then Backfill, then the admin agent if it steps in on its own.
- **Music missing** (from AI Search): an album's missing songs, or one that never came, searched for again by Lidarr, and by Backfill with **Music too** on; an artist's missing albums, searched for by Lidarr. Only what's missing can be fixed for music.
- **A broken file or the wrong episode**: a replacement is looked for, and the file is removed only once one is found. The same title is replaced at most once a day. From AI Search, these are filed as an issue and need permission to report issues.
- **A whole season that is bad** ("the whole of season 6 is messed up", "redownload season 2"): Sonarr searches for the season and takes a release none of the current files came from, a season pack your quality profile accepts first, otherwise one release per episode, in English or the series' own language, never from a blocked group. Only once it has been grabbed are the old releases marked failed in Sonarr (so they are never taken again) and the old files removed, so the new ones can import. If nothing else is found, nothing is removed and the admin agent looks further. Whoever reported it is told on the issue when the season is back.
  - **Admins** get it straight away, and can replace a season again the same day.
  - **Anyone else's** waits for an admin: it shows as **needs your approval** on the admin agent's page (Backfill → Agent), the issue says it's waiting, and the reporter hears what was decided. The same season can be asked for once a day.
  - A movie has one file, so "replace all of it" replaces that file, as for a broken one.

The season and episode you name ("season 6", "S06E03", "episode 3 of season 6") are kept with the fix and on the issue it files, so it shows that season rather than All Seasons. An issue filed on All Seasons whose description names a season is moved to that season.

When you ask to fix a season and nothing is missing from it, AI Search says what it checked and asks what's wrong: replace the whole season, check it for mixed-up episodes, or its subtitles. Answer in a few words ("replace all of it") and it carries on with the same season.

What a report asks for is read from its words. When those don't say clearly and AI is set up, the AI model reads them (**Understand Reports**, which sends only the report's words). On an issue it then fixes subtitles and missing episodes; anything that would replace files is left for an admin, with a comment saying what it read.

People who aren't admins are limited to 30 fixes, and 10 file replacements, a day.

Switch: `autoFix`.
