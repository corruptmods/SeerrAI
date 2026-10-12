# AI

[← Seerr AI guide](./README.md)

AI in Seerr AI suggests and explains. **It never acts on its own**: when AI Search sets up a request or a list, you see every title and confirm first, and requests then follow the usual rules. The one exception is the [admin agent](./backfill-and-agent.md#the-admin-agent), which admins turn on and limit themselves.

## Setting it up (admins)

**Settings → AI**:

- **Provider:** Claude (Anthropic), or OpenAI or any OpenAI-compatible server, including one at home (Ollama, LM Studio: enter its address, such as `http://your-server:11434/v1`; the key is then optional).
- **API key:** never shown again once saved, and only ever sent to the provider and address it was saved for.
- **Model:** used by every feature. Under **Advanced**, a cheaper or stronger model can be chosen per feature.
- **Daily Limit per Person:** answers each person gets a day (default 20; 0 is no limit). Admins aren't limited. Answers from memory, and failed or empty ones, don't count.
- **Test** checks the model answers.

Each feature sends only what it needs: titles as "Name (year)", never account names or emails. Answers are remembered for a while (an hour for searches, up to 30 days for recaps), and a repeat costs nothing.

### What it costs

Once a key is saved, a panel shows the balance you last entered less what has been spent since. Neither provider lets a program read your balance, so spending comes from the provider's own report if you save an optional admin key, or is estimated from the tokens Seerr AI used at prices you enter. When the provider says the account is out of credit, the panel and the person asking are told.

## The AI features

Each can be turned off in **Settings → Features** (for everyone) or in your own settings. They only appear once AI is set up.

| Feature | Where | Who | What it does |
|---|---|---|---|
| **AI Search** (`aiChat`) | The sparkle button beside search | Everyone | Describe a title, ask about what you watched, or send a photo. Finds up to 6 titles (20 for a list), and reads a whole franchise, studio, director's or actor's work from TMDB. Results can be opened, put on a list, or requested together after you confirm. Problems you mention can be passed to [Auto-fix](./subtitles-and-autofix.md#auto-fix). Admins can also ask for a file to be replaced, a release group blocked and so on; that goes to the [admin agent](./backfill-and-agent.md#changes-you-approve), which waits for their approval. |
| **Why These Suggestions** (`aiReasons`) | Suggested for You page | Everyone | Explains why each title was suggested. |
| **Pick for the Room** (`aiPicker`) | A tab in AI Search | Everyone | Choose who is watching (up to 6), movie or series, and a mood; it picks three titles, by default only ones ready to watch. You can include people you share a watch list with, if they haven't turned this off; admins can include anyone. |
| **Catch Me Up** (`aiRecap`) | Series pages | Everyone | A spoiler-free recap up to where you are (from your Plex history, or an episode you pick), built from TMDB's episode synopses. |
| **Review Deletions** (`aiDeletionReview`) | The Deleting Soon row | Request managers | Flags what Maintainerr is about to delete that might be a mistake: someone part-way through, often rewatched, recently requested, on a list. |
| **Suggest Issue Fixes** (`aiIssueTriage`) | An issue's page | Issue managers | Suggests a fix from the report and its comments. |
| **Explain Logs** (`aiLogs`) | Settings → Logs | Admins | Explains a log entry. Keys, tokens and emails are removed first. |
| **Backfill Second Opinion** (`aiBackfill`) | Backfill, when an admin searches one title | Admins | Places files whose names don't say which episode they are. Its placements are marked and left out of approval unless you include them. |
| **Admin Agent** (`aiAgent`) | Backfill → Agent | Admins | See [Backfill and the admin agent](./backfill-and-agent.md#the-admin-agent). |
