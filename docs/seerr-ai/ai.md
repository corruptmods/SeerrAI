# AI

[← Seerr AI guide](./README.md)

AI in Seerr AI suggests and explains. **It never acts on its own**: when AI Search sets up a request or a list, you see every title and confirm first, and requests then follow the usual rules. The one exception is the [admin agent](./backfill-and-agent.md#the-admin-agent), which admins turn on and limit themselves.

## Setting it up (admins)

**Settings → AI**:

- **Provider:** Claude (Anthropic), or OpenAI or any OpenAI-compatible server, including one at home (Ollama, LM Studio: enter its address, such as `http://your-server:11434/v1`; the key is then optional). A model at home keeps everything on your network.
- **API key:** never shown again once saved, and only ever sent to the provider and address it was saved for.
- **Model:** used by every feature. Under **Advanced**, a cheaper or stronger model can be chosen per feature.
- **Effort:** how hard the model thinks before answering. **Lowest**, the default, asks for the least each model accepts: the cheapest and fastest. **None** asks for no thinking at all: the cheapest and fastest with models that can turn it off, such as OpenAI's GPT-6 Luna; a model that can't turn thinking off gets the least it accepts, and Claude, which always thinks a little, gets **Low**. **Low**, **Medium** and **High** give better answers, often letting a cheaper model do as well as a dearer one, but cost more and take longer. With OpenAI, the admin agent thinks at the effort chosen even while it uses tools; if a model refuses an effort, the next one down is used. Under **Advanced**, each feature can have its own effort beside its model, or keep **Same as default**. The list shows only what the chosen model takes (Claude starts at **Low**; OpenAI's newer models at **None**), and is hidden for models without an effort setting, such as GPT-4o or Claude 3; for a server other than Anthropic or OpenAI itself, every effort is listed and any the model refuses is dropped.
- **Daily Limit per Person:** answers each person gets a day (default 20; 0 is no limit). Admins aren't limited. Answers from memory, and failed or empty ones, don't count.
- **Test** checks the model answers.

Each feature sends only what it needs, and keeps the answer short. Titles go as "Name (year)", never account names or emails. What people watched is sent for AI Search, suggestions and picks: at most 12 recent titles each, as names with a rough date, including recent Trakt titles when an admin has turned on **Use What People Watched on Trakt**; never a Trakt username, a whole history or any ids. With **Hide What You've Watched** on, titles you've watched are taken out of AI Search's suggestions and Pick for the Room's picks on the server, without being sent; issue comments are sent as written. Answers are remembered for a while (an hour for searches, up to 30 days for recaps), and a repeat costs nothing and doesn't count towards the limit.

### Choosing a model

The cheapest models, at the lowest effort, can give weak suggestions in AI Search: titles that don't fit what was asked, or the wrong film of the same name. If that happens, first raise **Effort** for AI Search to Medium under **Advanced**; if it's still poor, choose a mid-range model for AI Search (such as Claude Sonnet or Haiku, or a mid-range OpenAI model) and keep the cheap one for the smaller features. Recaps, reasons and log explanations do well on cheap models at the lowest effort.

### What it costs

Once a key is saved, a panel shows the balance you entered (as of when you saved it) less what has been spent since. Neither provider lets a program read your balance, so spending comes from:

- the provider's own report, if you save an optional admin key. It counts everything the account spends, not only Seerr AI. An OpenAI admin key can only be made by the organization's owner. Anthropic's report includes today's spending, usually within about four hours; where Anthropic's newer cost report isn't available to the account, its older one is used, which counts up to the last midnight (UTC);
- otherwise, an estimate from the tokens Seerr AI used, at prices you copy from the provider's pricing page.

When the provider says the account is out of credit, the panel and the person asking are told; the warning clears on the next good answer.

If Claude's safety checks stop an answer, the person asking is told that Claude declined to answer, instead of getting an empty reply.

## The AI features

Each can be turned off in **Settings → Features** (for everyone) or in your own settings. They only appear once AI is set up.

| Feature | Where | Who | What it does |
|---|---|---|---|
| **AI Search** (`aiChat`) | The sparkle button beside search | Everyone | Describe a title, ask about what you watched, or send a photo. With music on, it finds albums and artists too, each requested from its own tile. Finds up to 6 titles (20 for a list), and reads a whole franchise, studio, director's or actor's work from TMDB. Results can be opened, put on a list, or requested together after you confirm. Ask for a genre or kind of film (slasher films, anime) and every title shown is of that genre on TMDB; others are left out. Series are only checked against the genres TMDB has for series, so asking for horror doesn't hide series. Problems you mention can be passed to [Auto-fix](./subtitles-and-autofix.md#auto-fix), including a whole season to replace, or an album's missing songs. Admins can also ask for a file to be replaced, a release group blocked and so on; that goes to the [admin agent](./backfill-and-agent.md#changes-you-approve), which waits for their approval. |
| **Why These Suggestions** (`aiReasons`) | Suggested for You page | Everyone | Explains why each title was suggested. |
| **Pick for the Room** (`aiPicker`) | A tab in AI Search | Everyone | Choose who is watching (up to 6), movie or series, and a mood; it picks three titles from what each person has been watching, by default only ones ready to watch. You can include people you share a watch list with, if they haven't turned this off; admins can include anyone. |
| **Catch Me Up** (`aiRecap`) | Series pages | Everyone | A spoiler-free recap up to where you are (from your watch history on any connected server, or an episode you pick), built from TMDB's episode synopses; only those up to there are sent. |
| **Review Deletions** (`aiDeletionReview`) | The Deleting Soon row | Request managers | Flags what Maintainerr is about to delete that might be a mistake: someone part-way through, often rewatched, recently requested, on a list. How much it was watched (counts, never names) is read only while Who Watched (`whoWatched`) is on. |
| **Suggest Issue Fixes** (`aiIssueTriage`) | An issue's page | Issue managers | Suggests a fix from the report and its comments. |
| **Understand Reports** (`aiReports`) | Issues, and [Siri](./siri.md) | Everyone | Works out what a problem report asks for when the usual rules can't tell. Sends only the report's words. Fixes that replace files are asked about first (Siri) or left for an admin (issues). |
| **Explain Logs** (`aiLogs`) | Settings → Logs | Admins | Explains a log entry. Keys, tokens and emails are removed first. |
| **Backfill Second Opinion** (`aiBackfill`) | Backfill, when an admin searches one title; songs taken from albums | Admins | Places files whose names don't say which episode they are. Its placements are marked and left out of approval unless you include them. Also, for a song nothing else finds, names up to three of the artist's releases likely to hold it; the song is still only taken from a file named as it. |
| **Admin Agent** (`aiAgent`) | Backfill → Agent | Admins | See [Backfill and the admin agent](./backfill-and-agent.md#the-admin-agent). |
