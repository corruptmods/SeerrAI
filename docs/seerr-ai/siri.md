# Reporting with Siri

[← Seerr AI guide](./README.md)

Say **"Fix this show"** or **"Fix this movie"** to Siri while something is playing. Siri says what you're watching and asks what's wrong. Your answer is reported as an issue, and [Auto-fix](./subtitles-and-autofix.md#auto-fix) starts on it straight away.

```
You:   Hey Siri, fix this show.
Siri:  What's wrong with The Otterkin, season 2 episode 3?
You:   The subtitles are out of sync.
Siri:  Reported. I'm looking for subtitles now. You'll be told how it goes.
```

## What it understands

Your words are read by the same rules as an issue: subtitles missing or out of sync, "make subtitles", episodes missing, a broken or bad copy, the wrong episode, a whole bad season. When the rules can't tell and an admin has set up AI, the AI model reads them instead (**Understand Reports**, which sends only your words). If neither can tell, it's reported for an admin to look at.

Anything that replaces files (a broken copy, the wrong episode, a whole season) is always asked about first: "That replaces the file of The Otterkin, season 2 episode 3 with another copy. Should I go ahead?" **No** still reports it, for an admin, and leaves the files alone. The question lasts 5 minutes.

## What counts as playing

What the connected servers (Plex, Jellyfin, Emby) are playing for you now, playing before paused. If nothing is, what you stopped watching in the last half hour, so you can stop it and then report it. Only titles in Seerr's library can be reported. Plex needs Seerr's owner signed in with Plex; the half-hour fallback needs watch history (Tautulli for Plex).

## Setting it up

1. Open **Profile → Settings → Siri**. The page is there while **Siri Reports** is on and you can report problems.
2. Press **Add to Siri** and add the shortcut. Siri runs it by its name: call it **Fix this show**, and add it a second time as **Fix this movie** if you like.
3. When the shortcut asks, paste the **Server address** and a **Siri key** from the same page. Press **Make a Siri Key** and copy it; it's shown once.

A Siri key can only report problems with what you're watching, so it's safe on a phone. It doesn't need personal API keys to be turned on. Making a new one stops the old one. Someone who manages users can revoke it from your Siri page.

The address must be one your phone can reach away from home if you want it to work there.

## Making the shortcut (admins)

Seerr can't hand out a shortcut file itself, so an admin builds it once in the Shortcuts app, shares it, and pastes the iCloud link into **Settings → Features → Siri Shortcut**. Everyone's Siri page then offers it.

In Shortcuts, make a new shortcut named **Fix this show** with these actions:

1. **Text**: leave it empty. Rename the action's output to **Address**.
2. **Text**: leave it empty. Rename it to **Key**.
3. **Get Contents of URL**: `Address/api/v1/now-playing`. Method **GET**. Add a header `X-Api-Key` = **Key**.
4. **Get Dictionary Value**: `say` in **Contents of URL**. Rename it to **Say**.
5. **Get Dictionary Value**: `item` in **Contents of URL**. Rename it to **Item**.
6. **If** **Item** *does not have any value*:
   - **Show Result**: **Say**.
   - **Stop This Shortcut**.
   - **End If**.
7. **Ask for Input**: Text, prompt **Say**.
8. **Get Contents of URL**: `Address/api/v1/now-playing/report`. Method **POST**, header `X-Api-Key` = **Key**, Request Body **JSON** with `problem` (Text) = **Provided Input** and `item` (Text) = **Item**.
9. **Get Dictionary Value**: `say` in that result. Rename it to **Answer**.
10. **Get Dictionary Value**: `confirm` in that result. Rename it to **Confirm**.
11. **If** **Confirm** *has any value*:
    - **Choose from Menu**, prompt **Answer**, with two items, **Yes** and **No**.
    - Under **Yes**: **Get Contents of URL** `Address/api/v1/now-playing/answer`, **POST**, header `X-Api-Key` = **Key**, JSON `confirm` = **Confirm**, `answer` = `yes`. Then **Get Dictionary Value** `say` and **Show Result** of it.
    - Under **No**: the same with `answer` = `no`.
    - **Otherwise**: **Show Result**: **Answer**.
    - **End If**.

Then open the shortcut's settings (ⓘ), **Setup**, and add an **Import Question** for each of the two **Text** actions: "What's your Seerr address? It's on your Siri page." and "Paste your Siri key from your Siri page." Share it with **Copy iCloud Link** and paste that link into **Settings → Features**.

To keep "Fix this movie" to films when a show is playing too, add `?kind=movie` to the first address in a copy of the shortcut (`?kind=tv` for shows).

Switches: `siri` (Siri Reports), `aiReports` (Understand Reports). The API is under `siri` in the [API reference](../../seerr-api.yml).
