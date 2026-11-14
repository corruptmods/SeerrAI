import BootScreen from '@app/components/BootScreen';
import type { User } from '@app/hooks/useUser';
import {
  chosenAppearance,
  THEME_SCRIPT,
  THEME_STYLE_ID,
  themeAttributes,
  themeCss,
} from '@app/utils/theme';
import {
  customCssLinks,
  PERSONAL_CSS_ID,
  SAFE_MODE_PARAM,
  SAFE_MODE_SCRIPT,
  SERVER_CSS_ID,
  THEME_SAFE_STYLE_ID,
} from '@app/utils/theme/safeMode';
import type { Appearance } from '@server/constants/theme';
import {
  appearanceFromDefaults,
  SERVER_THEME_DEFAULTS,
} from '@server/constants/theme';
import { withoutThemeFile } from '@server/constants/themeFile';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import type { SeasonId } from '@server/lib/seasons';
import { localDay, shownSeason } from '@server/lib/seasons';
import type { AppProps } from 'next/app';
import type { DocumentContext, DocumentInitialProps } from 'next/document';
import Document, { Head, Html, Main, NextScript } from 'next/document';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import type { JSX } from 'react';

/** _app's props that the page's theme depends on. */
type ThemeAppProps = AppProps & {
  user?: User;
  currentSettings?: PublicSettingsResponse;
  deviceAppearance?: Appearance;
  seasonDay?: string;
};

type ThemedDocumentProps = DocumentInitialProps & {
  appearance: Appearance;
  season?: SeasonId;
  /** The script nonce in this page's Content-Security-Policy. */
  nonce?: string;
  interLatin?: string;
};

let interLatin: string | null | undefined;

/**
 * Where the build put Inter's Latin file (its name carries a hash), looked up
 * once. Preloading it lets text paint in Inter instead of swapping from a
 * fallback. Production builds only: a development server names it otherwise.
 */
const interLatinUrl = (): string | undefined => {
  if (interLatin === undefined) {
    interLatin = null;
    if (process.env.NODE_ENV === 'production') {
      try {
        const found = readdirSync(
          path.join(process.cwd(), '.next/static/media')
        ).filter((name) =>
          /^inter-latin-wght-normal\.[\w-]+\.woff2$/.test(name)
        );
        if (found.length === 1) {
          interLatin = `/_next/static/media/${found[0]}`;
        }
      } catch {
        // Not found: no preload, the stylesheet still loads it.
      }
    }
  }
  return interLatin ?? undefined;
};

/** The script nonce the server put in this page's Content-Security-Policy. */
const nonceOf = (policy: unknown): string | undefined =>
  typeof policy === 'string'
    ? /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1]
    : undefined;

class MyDocument extends Document<ThemedDocumentProps> {
  static async getInitialProps(
    ctx: DocumentContext
  ): Promise<ThemedDocumentProps> {
    // The theme depends on the user and server default, which _app already fetched.
    let appProps: ThemeAppProps | undefined;
    const renderPage = ctx.renderPage;
    ctx.renderPage = () =>
      renderPage({
        enhanceApp: (App) => {
          const Enhanced = (props: ThemeAppProps) => {
            appProps = props;
            return <App {...props} />;
          };
          return Enhanced;
        },
      });

    const initialProps = await Document.getInitialProps(ctx);
    const nonce = nonceOf(ctx.res?.getHeader('Content-Security-Policy'));
    const chosen = appProps?.currentSettings
      ? chosenAppearance({
          signedIn: !!appProps.user,
          own: appProps.user?.settings?.appearance,
          device: appProps.deviceAppearance,
          server: appProps.currentSettings.themeDefault,
        })
      : appearanceFromDefaults(SERVER_THEME_DEFAULTS);
    // Seasonal theme on top, if one runs today and isn't turned off.
    const season = shownSeason({
      calendar: appProps?.currentSettings?.seasons ?? [],
      seasonal: chosen.seasonal,
      note: appProps?.user?.settings?.seasonNote,
      today: appProps?.seasonDay ?? localDay(new Date()),
    })?.id;

    // Safe mode (?safe) drops custom CSS and theme files, not the built-in season.
    const safe = ctx.query[SAFE_MODE_PARAM] !== undefined;
    const appearance: Appearance = safe ? withoutThemeFile(chosen) : chosen;
    const links =
      safe || !appProps?.currentSettings
        ? {}
        : customCssLinks(
            appProps.currentSettings,
            appProps.user?.settings?.personalCssVersion
          );

    // After the app's stylesheets so custom CSS wins. In safe mode the script
    // removes custom CSS and theme files before first paint, keeping the season.
    const styles = (
      <>
        {initialProps.styles}
        {appearance.theme && (
          <style
            id={THEME_SAFE_STYLE_ID}
            media="not all"
            dangerouslySetInnerHTML={{
              __html: themeCss(withoutThemeFile(appearance), season),
            }}
          />
        )}
        {links.server && (
          <link rel="stylesheet" id={SERVER_CSS_ID} href={links.server} />
        )}
        {links.personal && (
          <link rel="stylesheet" id={PERSONAL_CSS_ID} href={links.personal} />
        )}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: SAFE_MODE_SCRIPT }}
        />
      </>
    );

    return {
      ...initialProps,
      appearance,
      season,
      nonce,
      styles,
      interLatin: interLatinUrl(),
    };
  }

  render(): JSX.Element {
    const { appearance, season, nonce, interLatin } = this.props;
    // The browser loads strings as a cached file (_app's startStrings); drop
    // them from page data (about 400 KB).
    delete (this.props.__NEXT_DATA__.props as { messages?: unknown }).messages;
    // Theme attributes, colours and the "Match my device" script are in the
    // page before first paint.
    return (
      <Html {...themeAttributes(appearance, season)}>
        <Head nonce={nonce}>
          {interLatin && (
            <link
              rel="preload"
              href={interLatin}
              as="font"
              type="font/woff2"
              crossOrigin="anonymous"
            />
          )}
          <style
            id={THEME_STYLE_ID}
            dangerouslySetInnerHTML={{ __html: themeCss(appearance, season) }}
          />
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
          />
        </Head>
        <body>
          <BootScreen />
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
