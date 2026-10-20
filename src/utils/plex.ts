import axios from 'axios';
import Bowser from 'bowser';
import type { PendingPlexSignIn, PlexSignInPurpose } from './plexSameTab';
import {
  plexForwardUrl,
  savePendingPlexSignIn,
  sessionStore,
} from './plexSameTab';

interface PlexHeaders extends Record<string, string> {
  Accept: string;
  'X-Plex-Product': string;
  'X-Plex-Version': string;
  'X-Plex-Client-Identifier': string;
  'X-Plex-Model': string;
  'X-Plex-Platform': string;
  'X-Plex-Platform-Version': string;
  'X-Plex-Device': string;
  'X-Plex-Device-Name': string;
  'X-Plex-Device-Screen-Resolution': string;
  'X-Plex-Language': string;
}

export interface PlexPin {
  id: number;
  code: string;
}

/** Plex's sign-in page, which takes its settings after `#!?`. */
const PLEX_AUTH_URL = 'https://app.plex.tv/auth/#!';

/** How long a single request to plex.tv may take. */
const PLEX_TIMEOUT_MS = 15000;

/**
 * Why signing in with Plex did not happen, for the page to say in plain
 * words:
 * - popup: the Plex window could not open, and the page could not go to
 *   Plex itself either;
 * - closed: the Plex window was closed before Plex was reached;
 * - unreachable: plex.tv could not be reached, or did not answer in time;
 * - expired: the sign-in took too long, or was started in another tab;
 * - notSignedIn: they came back from Plex without signing in;
 * - failed: anything else.
 */
export type PlexSignInProblem =
  | 'popup'
  | 'closed'
  | 'unreachable'
  | 'expired'
  | 'notSignedIn'
  | 'failed';

export class PlexSignInError extends Error {
  public problem: PlexSignInProblem;

  constructor(problem: PlexSignInProblem, cause?: unknown) {
    super(cause instanceof Error ? cause.message : `Plex sign-in: ${problem}`);
    this.name = 'PlexSignInError';
    this.problem = problem;
  }
}

/** The problem behind any error from signing in with Plex. */
export const plexSignInProblemOf = (e: unknown): PlexSignInProblem =>
  e instanceof PlexSignInError ? e.problem : 'failed';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class PlexOAuth {
  private plexHeaders?: PlexHeaders;

  private pin?: PlexPin;
  private popup?: Window;
  /** The last window asked for could not be opened at all. */
  private popupBlocked = false;

  private authToken?: string;

  public initializeHeaders(plexClientIdentifier: string): void {
    if (typeof window === 'undefined') {
      throw new Error(
        'Window is not defined. Are you calling this in the browser?'
      );
    }

    if (!plexClientIdentifier) {
      throw new Error(
        'Plex client identifier missing. Reload the page and try again.'
      );
    }

    const browser = Bowser.getParser(window.navigator.userAgent);
    this.plexHeaders = {
      Accept: 'application/json',
      'X-Plex-Product': 'Seerr AI',
      'X-Plex-Version': 'Plex OAuth',
      'X-Plex-Client-Identifier': plexClientIdentifier,
      'X-Plex-Model': 'Plex OAuth',
      'X-Plex-Platform': browser.getBrowserName(),
      'X-Plex-Platform-Version': browser.getBrowserVersion() || 'Unknown',
      'X-Plex-Device': browser.getOSName(),
      'X-Plex-Device-Name': `${browser.getBrowserName()} (Seerr AI)`,
      'X-Plex-Device-Screen-Resolution':
        window.screen.width + 'x' + window.screen.height,
      'X-Plex-Language': 'en',
    };
  }

  public async getPin(): Promise<PlexPin> {
    if (!this.plexHeaders) {
      throw new Error(
        'You must initialize the plex headers clientside to login'
      );
    }
    const response = await axios.post(
      'https://plex.tv/api/v2/pins?strong=true',
      undefined,
      { headers: this.plexHeaders, timeout: PLEX_TIMEOUT_MS }
    );

    this.pin = { id: response.data.id, code: response.data.code };

    return this.pin;
  }

  public preparePopup(): void {
    this.openPopup({ title: 'Plex Auth', w: 600, h: 700 });
  }

  /**
   * Signs in with Plex in the window opened by preparePopup, and resolves
   * to the Plex token once Plex says the person has signed in.
   *
   * When that window could not be opened and `sameTab` says what the
   * sign-in is for, this tab goes to Plex instead and comes back to the
   * same page (see plexSameTab.ts), which finishes it with finishSameTab;
   * it then resolves to undefined as the page is left. Every failure is a
   * PlexSignInError.
   */
  public async login(
    plexClientIdentifier: string,
    sameTab?: PlexSignInPurpose
  ): Promise<string | undefined> {
    try {
      this.initializeHeaders(plexClientIdentifier);
    } catch (e) {
      this.closePopup();
      throw new PlexSignInError('failed', e);
    }
    try {
      await this.getPin();
    } catch (e) {
      this.closePopup();
      throw new PlexSignInError('unreachable', e);
    }

    if (!this.plexHeaders || !this.pin) {
      throw new PlexSignInError('failed');
    }

    if (!this.popup || this.popup.closed) {
      const blocked = this.popupBlocked || !this.popup;
      this.popup = undefined;
      if (!blocked) {
        // They closed the window themselves while it was loading.
        throw new PlexSignInError('closed');
      }
      if (sameTab && this.goToPlex(sameTab)) {
        return undefined;
      }
      throw new PlexSignInError('popup');
    }

    this.popup.location.href = this.authUrl();

    return this.pinPoll();
  }

  /**
   * Finishes a sign-in this tab went to Plex for: asks Plex whether the
   * PIN was signed in to, a few times over a couple of seconds in case
   * Plex sent them back a moment before it had noted it. Resolves to the
   * Plex token.
   */
  public async finishSameTab(
    plexClientIdentifier: string,
    pending: PendingPlexSignIn
  ): Promise<string> {
    try {
      this.initializeHeaders(plexClientIdentifier);
    } catch (e) {
      throw new PlexSignInError('failed', e);
    }
    this.pin = { id: pending.id, code: pending.code };

    // Plex forgets a PIN once it has expired; a PIN it doesn't know of yet
    // is looked for again, as the window's polling does.
    let unknownPin = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await wait(1000);
      }
      let data: { authToken?: string | null } | undefined;
      try {
        const response = await axios.get(
          `https://plex.tv/api/v2/pins/${pending.id}`,
          { headers: this.plexHeaders, timeout: PLEX_TIMEOUT_MS }
        );
        data = response.data;
        unknownPin = false;
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          unknownPin = true;
          continue;
        }
        throw new PlexSignInError('unreachable', e);
      }
      if (data?.authToken) {
        this.authToken = data.authToken;
        return data.authToken;
      }
    }
    throw new PlexSignInError(unknownPin ? 'expired' : 'notSignedIn');
  }

  /** Plex's sign-in page for the current PIN, coming back to `forwardUrl`. */
  private authUrl(forwardUrl?: string): string {
    if (!this.plexHeaders || !this.pin) {
      throw new PlexSignInError('failed');
    }
    const params: Record<string, string> = {
      clientID: this.plexHeaders['X-Plex-Client-Identifier'],
      'context[device][product]': this.plexHeaders['X-Plex-Product'],
      'context[device][version]': this.plexHeaders['X-Plex-Version'],
      'context[device][platform]': this.plexHeaders['X-Plex-Platform'],
      'context[device][platformVersion]':
        this.plexHeaders['X-Plex-Platform-Version'],
      'context[device][device]': this.plexHeaders['X-Plex-Device'],
      'context[device][deviceName]': this.plexHeaders['X-Plex-Device-Name'],
      'context[device][model]': this.plexHeaders['X-Plex-Model'],
      'context[device][screenResolution]':
        this.plexHeaders['X-Plex-Device-Screen-Resolution'],
      'context[device][layout]': 'desktop',
      code: this.pin.code,
      ...(forwardUrl ? { forwardUrl } : {}),
    };
    return `${PLEX_AUTH_URL}?${this.encodeData(params)}`;
  }

  /**
   * Sends this tab to Plex's sign-in, to come back to the page it is on.
   * False, and nowhere sent, when the PIN can't be kept for the return.
   */
  private goToPlex(purpose: PlexSignInPurpose): boolean {
    if (!this.pin) return false;
    const kept = savePendingPlexSignIn(sessionStore(), {
      id: this.pin.id,
      code: this.pin.code,
      purpose,
      startedAt: Date.now(),
    });
    if (!kept) return false;
    window.location.assign(
      this.authUrl(plexForwardUrl(window.location.href, this.pin.id))
    );
    return true;
  }

  private async pinPoll(): Promise<string> {
    // popup.closed is unreliable under COOP same-origin-allow-popups once the
    // popup navigates to app.plex.tv; bound polling by expiresAt with a 15m
    // hard fallback.
    const deadline = Date.now() + 15 * 60 * 1000;
    const executePoll = async (
      resolve: (authToken: string) => void,
      reject: (e: Error) => void
    ) => {
      try {
        if (!this.pin) {
          throw new PlexSignInError('failed');
        }

        const response = await axios.get(
          `https://plex.tv/api/v2/pins/${this.pin.id}`,
          { headers: this.plexHeaders, timeout: PLEX_TIMEOUT_MS }
        );

        if (response.data?.authToken) {
          this.authToken = response.data.authToken as string;
          this.closePopup();
          resolve(this.authToken);
        } else {
          const expiresAt = response.data?.expiresAt
            ? Date.parse(response.data.expiresAt)
            : deadline;
          if (Date.now() >= Math.min(expiresAt, deadline)) {
            this.closePopup();
            reject(new PlexSignInError('expired'));
            return;
          }
          setTimeout(executePoll, 1000, resolve, reject);
        }
      } catch (e) {
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        if (status === 404 && Date.now() < deadline) {
          setTimeout(executePoll, 1000, resolve, reject);
          return;
        }
        this.closePopup();
        reject(new PlexSignInError('unreachable', e));
      }
    };

    return new Promise(executePoll);
  }

  private closePopup(): void {
    this.popup?.close();
    this.popup = undefined;
  }

  private openPopup({
    title,
    w,
    h,
  }: {
    title: string;
    w: number;
    h: number;
  }): Window | void {
    if (typeof window === 'undefined') {
      throw new Error(
        'Window is undefined. Are you running this in the browser?'
      );
    }
    // Fixes dual-screen position                         Most browsers      Firefox
    const dualScreenLeft =
      window.screenLeft != undefined ? window.screenLeft : window.screenX;
    const dualScreenTop =
      window.screenTop != undefined ? window.screenTop : window.screenY;
    const width = window.innerWidth
      ? window.innerWidth
      : document.documentElement.clientWidth
        ? document.documentElement.clientWidth
        : screen.width;
    const height = window.innerHeight
      ? window.innerHeight
      : document.documentElement.clientHeight
        ? document.documentElement.clientHeight
        : screen.height;
    const left = width / 2 - w / 2 + dualScreenLeft;
    const top = height / 2 - h / 2 + dualScreenTop;

    //Set url to login/plex/loading so browser doesn't block popup
    const newWindow = window.open(
      '/login/plex/loading',
      title,
      'scrollbars=yes, width=' +
        w +
        ', height=' +
        h +
        ', top=' +
        top +
        ', left=' +
        left
    );
    // Some blockers hand back a window that is already closed.
    this.popupBlocked = !newWindow || newWindow.closed;
    if (newWindow && !newWindow.closed) {
      newWindow.focus();
      this.popup = newWindow;
      return this.popup;
    }
    this.popup = undefined;
  }

  private encodeData(data: Record<string, string>): string {
    return Object.keys(data)
      .map(function (key) {
        return [key, data[key]].map(encodeURIComponent).join('=');
      })
      .join('&');
  }
}

export default PlexOAuth;
