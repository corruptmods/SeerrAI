# Themes

[← Seerr AI guide](./README.md)

Seerr AI can be light or dark, in the accent colour you like. Everyone chooses their own look; nobody else's screen changes. An admin sets the look for everyone who hasn't chosen, and for the sign-in page. Until then a server looks as it always did: dark, Classic, Indigo.

## Choosing your look

1. Open **Profile → Settings → Appearance**.
2. Pick what you like. Each change shows at once, on your screen only, with a preview on the right.
3. Press **Save Changes**. Leave without saving and your saved look comes back.

Your look is saved with your account, so it follows you to every device. Your device keeps a copy too, so the sign-in page looks the same.

What you can choose:

- **Mode**: **Light**, **Dark**, or **Match my device** (follows your phone's or computer's setting, and switches when it does).
- **Accent colour**: buttons, links, switches and highlights. **Indigo**, **Seerr AI** (violet), **Teal**, **Green**, **Rose**, **Amber**, **Plex**, **Jellyfin**, or **Custom** (pick or type any colour, such as `#0ea5e9`). If white text wouldn't be readable on your colour, buttons get dark text and the page says so.
- **Dark background**, used whenever it's dark: **Classic**, **True black** (for OLED screens), **Slate** (cool blue-grey) or **Warm** (brown-grey).
- **Seasonal themes**: on or off for you. See [Seasonal themes](#seasonal-themes).
- **Extras**: **Spacing** (**Compact** fits more on screen), **Corners** (**Square**), **Blur behind title pages** (off to start), and **Reduce see-through panels** (solid panels; easier on older phones).
- **Themes**: ready-made looks and theme files. See [Theme files](#theme-files).
- **Personal CSS**, if an admin allows it. See [Custom CSS](#custom-css).

**Use the Server's Default** forgets your choice and follows the server's look again, including later changes to it.

Every built-in colour, and every custom one, is checked so text stays readable.

## The server's look (admins)

**Settings → Appearance** sets the default **Mode** (Dark, Light, or Match the person's device), **Accent colour** and **Dark background**, or a **Theme file**. It's for everyone who hasn't chosen their own and for the sign-in page; nobody is locked to it. The same page has the seasons and **Server CSS**.

## What to expect in light mode

Every page follows the look, Settings, windows and the sign-in page included. A few things stay as they are on purpose:

- **Pictures stay pictures.** Text on a poster or backdrop keeps a dark layer under it. Badges on posters are solid in light mode.
- **Logos**: dark logos (Plex, Radarr and others in Settings) sit on a small dark tile in light mode.
- **Windows and menus are solid in light mode**; the dimming behind a window stays dark.
- **Amber, Plex and pale custom colours** use dark button text, so their buttons are solid in dark mode too.

## Seasonal themes

For a few days a year a season sits on top of everyone's look: its colour on buttons and highlights, its night as the dark background, and a small mark by the logo. Light mode stays light; posters are never covered. When it ends, your own look comes back by itself.

| Season | When | On a new server |
|---|---|---|
| **Halloween** (orange, a crescent moon) | 24 October to 1 November | On |
| **Holidays** (evergreen, a gold star) | 1 to 28 December | On |
| **New Year** (champagne gold, a spark) | 29 December to 2 January | On |
| **Lunar New Year** (lantern red, a lantern) | New Year's Eve to the Lantern Festival, worked out each year | Off |

**The first time a season shows**, a note offers **Keep** or **Turn off**. **Turn off** is for that season, this year; your answer follows you to other devices. To stop seasons for good, switch off **Seasonal themes** in **Profile → Settings → Appearance**. A season turned off from its note comes back with **Show It Again** there.

Days follow your own calendar: a season starts at midnight where you are. If two overlap, the newer one shows. Nothing moves if your device is set to reduce motion.

**Admins** choose the seasons under **Settings → Appearance → Seasonal themes**: each on or off, with its first and last day, then **Save Changes**. A last day earlier than the first means the next year. Lunar New Year's dates come from a table for 2025 to 2040 (China's dates); **Set the Dates** fixes them by hand, **Work Them Out Each Year** goes back to the table. After 2040 it needs a newer Seerr AI.

## Theme files

**Profile → Settings → Appearance → Themes** has four looks to start from: **Seerr Classic** (dark, Indigo), **Midnight** (true black, Teal), **Daylight** (light, Indigo) and **Ember** (warm, Rose). Pick one, then **Save Changes**.

To share a look:

1. **Export My Theme** saves yours as `my-seerr-ai-theme.seerr-theme.json`.
2. Someone else presses **Import a Theme** on their Appearance page and picks the file (or pastes its text). They see it in dark and light first, with a warning if any text would be hard to read.
3. **Use This Theme**, then **Save Changes**.

While a theme file is in use the page says so, with **Stop Using It**. Choosing another accent colour also stops it.

Admins can make one the server's default: **Settings → Appearance → Theme file → Import a Theme**, then **Save Changes**.

A theme file holds only colours and a few settings, so it can't break with an update or carry anything else onto the page. The server checks it strictly: only the names below, colours as `#rrggbb` or `#rgb`, at most 16 KB; anything unknown refuses the whole file, with the reason. Everything except `seerrTheme` and `name` is optional.

```json
{
  "seerrTheme": 1,
  "name": "Ember",
  "author": "Sam",
  "dark": {
    "page": "#1c1917",
    "surface": "#292524",
    "gray": { "800": "#292524", "900": "#1c1917" }
  },
  "light": { "page": "#fafaf9" },
  "accent": { "fill": "#be123c", "dark": { "text": "#fb7185" } },
  "extras": { "mode": "dark", "corners": "square" }
}
```

| Part | What it may hold |
|---|---|
| `seerrTheme` | `1`, the format's version |
| `name`, `author` | Plain text, up to 60 characters |
| `dark`, `light` | `page`, `surface`, `surfaceRaised`, `sidebar`, `sidebarTo`, `overlay`, `overlayStrong`, `mediaScrim`, `textStrong`, `textDefault`, `textMuted`, `borderSubtle`, `borderStrong`, `field`, `fieldBorder`, and `gray` steps `50` to `950` |
| `accent` | `fill`, `ink` (text on the fill), `scale` and `alt` (steps `50` to `950`), and `dark`/`light` with any of `hover`, `text`, `soft`, `alt`, `altHover`, `chip`, `onChip` |
| `extras` | Applied on import: `mode` (`dark`, `light`, `auto`), `spacing` (`comfortable`, `compact`), `corners` (`rounded`, `square`), `blur`, `solidPanels` (`true`/`false`) |

Success, warning, danger and information colours stay Seerr AI's own. An exported file has every colour in both modes.

## Custom CSS

**Settings → Appearance → Server CSS** (admins): styles for everyone, the sign-in page included, up to 64 KB. It may `@import` a stylesheet from elsewhere, such as a [theme.park](https://theme-park.dev) theme. Pages only load stylesheets and fonts from this server and the places Server CSS names, so `@import` anything an imported stylesheet pulls in too.

**Let people add their own CSS** (off to start) shows **Personal CSS** on everyone's Appearance page. It changes only their own screens, once signed in, up to 32 KB. Because styles are often pasted from somewhere, Personal CSS may not do anything that could send something elsewhere. It may not:

- `@import` other stylesheets;
- use pictures or fonts from elsewhere: `url()` only takes a path on this server (`/my-picture.png`), `#id`, or `data:image/…` / `data:font/…`; no `image-set()`;
- run anything (`expression()`, `behavior`, `-moz-binding`, `javascript:`).

The page flags problems as you type, and the server checks again on save and on every load. Switching the setting off stops everyone's at once; their CSS is kept for when it's back on.

### Style hooks

Style these `data-seerr` names: they stay the same between versions, while class names may change.

| `data-seerr` | What it is |
|---|---|
| `sidebar`, `top-bar`, `search`, `user-menu` | The sidebar, the top bar, the search box, the menu under your picture |
| `bottom-bar`, `more-menu` | A phone's bottom bar and its More menu |
| `page` | The page below the top bar |
| `title-card`, `poster`, `title-header` | A card in a row or grid, its picture, the top of a title page |
| `slider`, `request-card` | A sideways row, a Recent Requests card |
| `button`, `badge`, `alert`, `table`, `toast` | Buttons, small labels, message boxes, tables, pop-up notifications |
| `modal`, `slide-over` | A window over the page, a panel from the side |
| `settings`, `setting-section` | A Settings page's content, an Appearance section |
| `login` | The sign-in page |
| `season-mark` | The mark by the logo during a season |

The `<html>` element says which look is showing:

| Attribute | Values |
|---|---|
| `data-mode` | `dark` or `light`, as shown now |
| `data-mode-choice` | `dark`, `light` or `auto` |
| `data-theme` | `classic`, `black`, `slate`, `warm` |
| `data-accent` | `indigo`, `seerr`, `teal`, `green`, `rose`, `amber`, `plex`, `jellyfin`, `custom` |
| `data-spacing`, `data-corners`, `data-blur`, `data-solid` | Only when not the usual: `compact`, `square`, `on`, `on` |
| `data-season` | During a season: `halloween`, `holidays`, `newyear`, `lunarnewyear` |

```css
[data-mode="light"] [data-seerr="title-card"] { box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); }
```

Colours are CSS variables set for the look in use: restyle a colour through a variable or a hook, not a class.

## Safe mode

If a style or theme file breaks a page, add `?safe` to the address (`https://seerr.example/?safe`). Seerr AI opens without custom CSS or theme files (seasons still show). The sign-in page links to it when the server has Server CSS or a theme file, and both Appearance pages have **Open Seerr AI without custom CSS**. Safe mode lasts in that tab until you press **Turn Off** in the note at the bottom. Fix the style, then turn it off.

## API

- `GET`/`POST /api/v1/user/{userId}/settings/appearance`: a person's look, or `null` for the server's.
- `POST /api/v1/user/{userId}/settings/appearance/season`: their answer to a season's note.
- `GET`/`POST /api/v1/user/{userId}/settings/css`: their own CSS.
- `GET`/`POST /api/v1/settings/appearance`: the server's default.
- `GET`/`POST /api/v1/settings/appearance/seasons`: the seasons (running ones are also in the public settings as `seasons`).
- `GET`/`POST /api/v1/settings/appearance/css`: Server CSS, and whether people may add their own.
- `GET /api/v1/style/server.css`, `/api/v1/style/personal.css`: the stylesheets pages load.

See [seerr-api.yml](../../seerr-api.yml).
