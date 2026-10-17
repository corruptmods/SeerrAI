# Themes

[← Seerr AI guide](./README.md)

Seerr AI can be light or dark, in an accent colour of your choice, on one of four dark backgrounds. Everyone chooses their own look, and nobody else's screen changes. An admin chooses the look of everyone who hasn't chosen one, and of the sign-in page. A server that has never been given a look shows exactly what Seerr AI looked like before themes: dark, Classic, with Indigo.

For a few days a year a seasonal theme sits on top, looks can be shared as theme files, and admins can add their own CSS. If a style ever breaks a page, [safe mode](#safe-mode) opens Seerr AI without it.

## Your own look

**Profile → Settings → Appearance.** Every change shows at once, on your screen only, so you can try things; **Save Changes** keeps it. Leave the page without saving and your saved look comes back. It's kept with your account, so it follows you to every phone and computer you sign in on.

- **Mode**: **Light**, **Dark**, or **Match my device**, which follows your phone's or computer's own light or dark setting, and switches when it does.
- **Accent colour**: the colour of buttons, links, switches and highlights. **Indigo** is how Seerr AI has always looked; there are also **Seerr AI** (the logo's violet), **Teal**, **Green**, **Rose**, **Amber**, **Plex** and **Jellyfin**. **Custom** takes any colour you pick or type (such as `#0ea5e9`) and makes the lighter and darker shades from it. If white text wouldn't be readable on your colour, buttons get dark text instead, and the page says so.
- **Dark background**: used whenever Seerr AI is dark. **Classic** is how it has always looked; **True black** is black, for OLED screens; **Slate** is a cooler blue-grey; **Warm** is a brown-grey.
- **Seasonal themes**: on or off for you, with the seasons this server runs and when they're next on. **Preview** shows one on top of the look you're choosing. See [Seasonal themes](#seasonal-themes).
- **Extras**:
  - **Spacing**: **Compact** puts rows, cards, form fields, tables, menus and the rows of Requests, Issues and the Blocklist closer together.
  - **Corners**: **Square** takes the rounding off panels, buttons and cards.
  - **Blur behind title pages**: softens the picture behind a film, series, collection or artist. Off unless you turn it on, so title pages look as they always have.
  - **Reduce see-through panels**: solid buttons, menus and bars instead of see-through ones. Easier on older phones.
- **Themes**: ready-made looks and theme files; see [Theme files](#theme-files).
- **Personal CSS**, when an admin allows it; see [Custom CSS](#custom-css).
- **Use the Server's Default** forgets your choice and gives you the server's look again, including any change an admin makes to it later.

The colours are chosen so text stays readable: every built-in accent and background is checked for contrast, and so is every custom colour.

Your device also keeps a copy of your look, so the sign-in page looks the way you left it. Once you sign in, your account's look is used.

## The server's look

**Settings → Appearance** (admins): **Mode** (Dark, Light, or Match the person's device), **Accent colour** (Custom included) and **Dark background**, or a **Theme file** (see below). It's the look of everyone who hasn't chosen their own, and of the sign-in page. Nobody is locked to it: everyone can still choose their own. The same page has the [seasons](#seasonal-themes) the server runs and its [Server CSS](#custom-css).

## Everywhere, in every look

Every page follows the look, light or dark: the sidebar, the top bar, the bar along the bottom of a phone and its **More** menu, Discover and its rows, search, film, series, collection, music and people's pages, lists, Requests, Issues, the Blocklist, the calendar, Backfill and its agent, Settings (every tab), Users, profiles, Health, Jobs and Logs, the AI panels, every window and slide-over, notifications that pop up, form fields and drop-down lists, the date picker, the sign-in, first-time setup and password reset pages, the page's scrollbar, the app's start-up screen and the colour of the browser's own bar (or the phone's status bar in the installed app).

A few things are worth knowing:

- **Pictures stay pictures.** The picture behind a title fades into the page: in dark as it always has, in light with more of the page's colour over it, so the dark writing over it can be read whatever the picture is. Writing on a poster or other picture (a poster pointed at, a list's posters, the genre cards, a collection's banner) keeps a dark layer under it and stays light in every look. The small badges on posters (Movie, Series, Available, Requested…) are solid in light mode, so they read on any picture. Pictures behind the rows of Requests, Issues and the Blocklist fade into the row's own colour.
- **Logos.** The Seerr AI logo has a dark wordmark in light mode. Studio and network logos are white on dark and dark on light. Service logos drawn for a dark background (Plex, Radarr, qBittorrent, IMDb, Trakt and the rest, in Settings and under a title's details) sit on a small dark tile in light mode.
- **True black, Slate and Warm** fade pictures into their own background, without Classic's blue-grey, and their green, yellow and red buttons and badges are a shade deeper, so the writing on them reads. A seasonal theme's night does the same.
- **Accents with dark button text** (Amber, Plex, a pale custom colour, and the Halloween, New Year and Diwali seasons) have solid buttons and badges in dark mode rather than see-through ones, so the text keeps its contrast.
- **Windows and menus are solid in light mode**, so the page behind doesn't grey them; the dimming behind a window stays dark in every look.
- **Notes and guides** written in Markdown keep their bold text and headings stronger than the text around them.
- **Keyboard focus** shows as a ring in the accent colour, in every look.

## Seasonal themes

For a few days a year Seerr AI dresses up for a season. A season sits on top of everyone's own look: buttons, links and highlights take its colour, in dark mode the background becomes its night (a deep purple for Halloween, evergreen for the holidays, midnight blue for New Year), light mode stays light, and a small mark sits by the logo. Posters and pictures are never covered, and your spacing, corners and solid panels stay as you set them. A season sits on top of a [theme file](#theme-files) in the same way. When its last day has passed, your own look comes back by itself.

| Season | When | On a new server |
|---|---|---|
| **Halloween** (orange, a crescent moon) | 24 October to 1 November | On |
| **Holidays** (evergreen, a gold star) | 1 to 28 December | On |
| **New Year** (champagne gold, a spark) | 29 December to 2 January | On |
| **Lunar New Year** (lantern red, a lantern) | New Year's Eve to the Lantern Festival, worked out each year | Off |
| **Diwali** (marigold, a diya) | Its five days, Dhanteras to Bhai Dooj, worked out each year | Off |
| **Pride Month** (violet, a rainbow) | All of June | Off |

Holidays has a star and evergreen rather than snow, as December is summer for half the world.

**The first time you see a season**, a note says which it is and until when, with **Keep** and **Turn off** (on a phone it sits just above the bar along the bottom). **Turn off** is for that season only: your own look comes back at once, and the season returns next year. Your answer is kept with your account, so your other devices don't ask again. To turn seasons off for good, switch off **Seasonal themes** in **Profile → Settings → Appearance**; a season you turned off from its note can be brought back there with **Show It Again**.

Days are counted on your own calendar: a season starts and ends at midnight where you are, not where the server is. If two seasons meet (Diwali often falls during Halloween), the one that started most recently shows. The mark fades in, unless your device is set to reduce motion, in which case nothing moves.

**Admins** choose the seasons in **Settings → Appearance → Seasonal themes**: each one on or off, with its first and last day, then **Save Changes**. A last day earlier in the year than the first means the next year, as with New Year. Lunar New Year and Diwali move from year to year, so their days are worked out from a table: Lunar New Year from 2025 to 2040 (China's dates, from the Hong Kong Observatory's calendar tables, checked against timeanddate.com and Wikipedia), Diwali from 2025 to 2036 (India's dates, from timeanddate.com and qppstudio.net, checked against Drik Panchang). Places far from China or India can keep them a day apart in some years. **Set the Dates** fixes them by hand instead, the same days every year, and **Work Them Out Each Year** goes back to the table. Past the table's last year a season with worked-out dates doesn't run; a newer version of Seerr AI brings more years.

## Theme files

**Profile → Settings → Appearance → Themes** has four built-in looks to start from: **Seerr Classic** (dark, Indigo, how Seerr AI has always looked), **Midnight** (true black with Teal), **Daylight** (light with Indigo) and **Ember** (warm with Rose). Picking one fills in the choices above it; **Save Changes** keeps it.

**Export My Theme** saves your look as a theme file (`my-seerr-ai-theme.seerr-theme.json`) that anyone can import on their own Appearance page, on this server or another. **Import a Theme** takes such a file (or its text, pasted), shows its name and what it looks like in dark and light before anything changes, and warns if some of its text would be hard to read. **Use This Theme** puts it into the page, and **Save Changes** keeps it with your account. While a theme file is in use the page says so, with **Stop Using It**; picking another accent colour (or another dark background, when the file has its own dark colours) stops using it too, so your choice shows.

Admins can make a theme file the server's default: **Settings → Appearance → Theme file → Import a Theme**, then **Save Changes**. Everyone using the default gets it, the sign-in page included.

A theme file holds colours and a few settings, nothing else, so an update can't break one and one can't carry anything onto the page but colours. The server checks each one strictly: only the names below, colours written `#rrggbb` (or `#rgb`), at most 16 KB, and anything it doesn't know refuses the whole file, with the reason. Everything but `seerrTheme` and `name` can be left out; what a file leaves out comes from the look it's used with.

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
| `seerrTheme` | `1`, the version of the format |
| `name`, `author` | Plain text, up to 60 characters each |
| `dark`, `light` | The colours used in that mode: `page`, `surface`, `surfaceRaised`, `sidebar`, `sidebarTo` (the sidebar's gradient), `overlay`, `overlayStrong` (behind windows), `mediaScrim` (behind text on pictures), `textStrong`, `textDefault`, `textMuted`, `borderSubtle`, `borderStrong`, `field`, `fieldBorder`, and `gray` with any of the steps `50` to `950` (the in-between shades some pieces use) |
| `accent` | `fill` (buttons and switches; the rest is worked out from it), `ink` (text on the fill), `scale` and `alt` (the accent's steps `50` to `950`, and its gradient partner's), and `dark` and `light`, each with any of `hover`, `text` (links), `soft`, `alt`, `altHover`, `chip`, `onChip` |
| `extras` | Taken when the file is imported: `mode` (`dark`, `light`, `auto`), `spacing` (`comfortable`, `compact`), `corners` (`rounded`, `square`), `blur` and `solidPanels` (`true` or `false`) |

The colours of success, warning, danger and information stay Seerr AI's own, chosen for contrast in each mode. An exported file has every colour in both modes, so importing it gives exactly the same look back.

## Custom CSS

**Settings → Appearance → Server CSS** (admins) holds styles for everyone, the sign-in page included, up to 64 KB. It may bring in a stylesheet from elsewhere with `@import`, such as a [theme.park](https://theme-park.dev) theme. Each page's Content-Security-Policy allows stylesheets and fonts only from this server and from the places Server CSS names, so if an imported stylesheet brings in more from somewhere else, `@import` that too.

**Let people add their own CSS** (off at first) shows **Personal CSS** in everyone's Appearance settings. Someone's own CSS changes only their own screens, once they're signed in. Because a style is often pasted from somewhere, theirs may not:

- bring in other stylesheets (`@import`);
- use pictures or fonts from anywhere but this server: `url()` may only be a path such as `/my-picture.png`, a part of the page (`#id`), or a picture or font written into the CSS (`data:image/…`, `data:font/…`). `image-set()` isn't allowed;
- run anything (`expression()`, `behavior`, `-moz-binding`, `javascript:`).

The page says what's wrong while you type, and the server checks again when it's saved and every time it's loaded. Switching **Let people add their own CSS** off stops everyone's at once; it's kept, and comes back if it's switched on again. Personal CSS is up to 32 KB.

Pictures aren't limited by the Content-Security-Policy, as posters, avatars and logos come from many places; the check on Personal CSS is what keeps its pictures on this server.

Colours come from CSS variables on the page, set for the look in use, so restyling a colour means setting the variable or styling one of the hooks below, not editing a class's colour.

### Style hooks

Custom CSS should style these names, which stay the same between versions; class names and the page's structure may change with any update. Each is a `data-seerr` attribute:

| `data-seerr` | What it is |
|---|---|
| `sidebar` | The sidebar (on a computer, and the one that slides in on a tablet) |
| `top-bar` | The bar along the top with search and your menu |
| `search` | The search box |
| `user-menu` | The menu under your picture |
| `bottom-bar` | The bar along the bottom of a phone |
| `more-menu` | The phone's More menu |
| `page` | The page's content, below the top bar |
| `title-card` | A card for a film, series, album or artist in a row or grid |
| `poster` | A card's picture, and the poster on a title page |
| `title-header` | The top of a film's or series' page: poster, title and buttons |
| `slider` | A row of cards that scrolls sideways |
| `request-card` | A request in Discover's Recent Requests |
| `button` | A button |
| `badge` | A small label, such as Available or Requested |
| `alert` | A message box in a page |
| `modal` | A window that opens over the page |
| `slide-over` | A panel that slides in from the side |
| `table` | A table |
| `toast` | A notification that pops up |
| `settings` | The content of a Settings or Profile → Settings page |
| `setting-section` | A section of the Appearance settings |
| `login` | The sign-in page |
| `season-mark` | The mark by the logo while a [seasonal theme](#seasonal-themes) shows |

The page's `<html>` element says which look is showing, so a style can be for one mode, background or accent only:

| Attribute | Values |
|---|---|
| `data-mode` | `dark` or `light`: what is showing now |
| `data-mode-choice` | `dark`, `light` or `auto` (Match my device) |
| `data-theme` | the dark background: `classic`, `black`, `slate`, `warm` |
| `data-accent` | `indigo`, `seerr`, `teal`, `green`, `rose`, `amber`, `plex`, `jellyfin`, `custom` |
| `data-spacing`, `data-corners`, `data-blur`, `data-solid` | only when not the usual: `compact`, `square`, `on`, `on` |
| `data-season` | only while a seasonal theme shows: `halloween`, `holidays`, `newyear`, `lunarnewyear`, `diwali`, `pride` |

```css
[data-mode="light"] [data-seerr="title-card"] { box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); }
```

## Safe mode

If a style or theme file breaks the page, add `?safe` to any address (`https://seerr.example/?safe`) to open Seerr AI without any custom CSS or theme files. Seasonal themes are built in, so a season still shows. The sign-in page has a link for it when the server has Server CSS or a theme file, and so do both Appearance pages (**Open Seerr AI without custom CSS**). The tab remembers it, page after page, until it's turned off with **Turn Off** in the note at the bottom of the screen; other tabs aren't affected. Fix the style in Settings or your profile, then turn safe mode off.

## API

- `GET` and `POST /api/v1/user/{userId}/settings/appearance`: a person's own look, or `null` for the server's. A theme file in use is its `theme` part.
- `POST /api/v1/user/{userId}/settings/appearance/season`: their answer to a season's note.
- `GET` and `POST /api/v1/user/{userId}/settings/css`: a person's own CSS; a refusal says why.
- `GET` and `POST /api/v1/settings/appearance`: the server's default, a theme file included.
- `GET` and `POST /api/v1/settings/appearance/seasons`: the seasons the server runs. The ones that run are also in the public settings, as `seasons`.
- `GET` and `POST /api/v1/settings/appearance/css`: Server CSS, and whether people may add their own.
- `GET /api/v1/style/server.css` and `/api/v1/style/personal.css`: the stylesheets pages load.

See [seerr-api.yml](../../seerr-api.yml).
