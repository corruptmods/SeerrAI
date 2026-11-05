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

/** Plex's sign-in page; settings go after `#!?`. */
const PLEX_AUTH_URL = 'https://app.plex.tv/auth/#!';

/** Per-request timeout for plex.tv. */
const PLEX_TIMEOUT_MS = 15000;

/**
 * Why a Plex sign-in failed:
 * - popup: no popup, and same-tab sign-in wasn't possible either;
 * - closed: the popup closed before reaching Plex;
 * - unreachable: plex.tv unreachable or timed out;
 * - expired: took too long, or started in another tab;
 * - notSignedIn: returned from Plex without signing in;
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

/** Maps any Plex sign-in error to its problem. */
export const plexSignInProblemOf = (e: unknown): PlexSignInProblem =>
  e instanceof PlexSignInError ? e.problem : 'failed';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class PlexOAuth {
  private plexHeaders?: PlexHeaders;

  private pin?: PlexPin;
  private popup?: Window;
  /** The last popup failed to open. */
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
   * Signs in via the popup from preparePopup; resolves to the Plex token.
   *
   * If the popup failed and `sameTab` is given, navigates this tab to Plex
   * instead (see plexSameTab.ts; finished by finishSameTab) and resolves to
   * undefined. Failures throw PlexSignInError.
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
        // Closed by the user while loading.
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
   * Finishes a same-tab sign-in; resolves to the Plex token. Retries for a
   * couple of seconds in case Plex redirects before recording the claim.
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

    // Plex forgets expired PINs; an unknown PIN is retried, as popup polling does.
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

  /** Plex's sign-in URL for the current PIN, returning to `forwardUrl`. */
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

  /** Sends this tab to Plex's sign-in. False, without navigating, if the PIN can't be stored. */
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
    // Dual-screen position: most browsers, then Firefox.
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

    // Open on login/plex/loading so the browser doesn't block the popup.
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
    // Some blockers return an already-closed window.
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
