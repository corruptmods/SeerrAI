/**
 * The screen shown while the installed app starts.
 *
 * iOS draws a static splash image before Seerr runs at all; nothing can
 * animate that. This takes over from it: the first frame is identical — the
 * same background, and the same logo at 40% of the screen width, centred,
 * which is where every apple-splash image places it — and then it animates
 * until the app is ready, when _app fades it out.
 *
 * It is plain markup and CSS in the document, not a React component in the
 * app tree, so it paints before any JavaScript has run. The animations use
 * only transform and opacity, which the browser runs on the compositor, so
 * they keep moving while the main thread is busy starting the app — the slow
 * part of a cold start.
 *
 * Shown only in the installed app (display-mode: standalone). If the app
 * never starts, it hides itself after 12 seconds rather than covering the
 * page for good. Reduce Motion leaves the logo still.
 */
const BOOT_CSS =
  '#boot-screen{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#111827;animation:boot-failsafe .3s ease 12s forwards}\n#boot-screen.boot-done{opacity:0;transition:opacity .35s ease;pointer-events:none}\n#boot-screen .boot-mark{position:relative;width:min(40vw,560px);height:min(40vw,560px)}\n#boot-screen .boot-logo{position:absolute;inset:0;width:100%;height:100%;overflow:visible;animation:boot-breathe 2.4s ease-in-out infinite;will-change:transform}\n#boot-screen .boot-glow{position:absolute;inset:-22%;border-radius:50%;background:radial-gradient(closest-side,rgba(139,92,246,0) 58%,rgba(139,92,246,.4) 72%,rgba(99,102,241,0) 100%);opacity:0;animation:boot-glow 2.4s ease-in-out infinite;will-change:opacity,transform}\n#boot-screen .boot-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(167,139,250,.6);opacity:0;animation:boot-ripple 2.4s cubic-bezier(.2,.6,.3,1) infinite;will-change:transform,opacity}\n#boot-screen .boot-ring.boot-ring-2{animation-delay:1.2s}\n@keyframes boot-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}\n@keyframes boot-glow{0%,100%{opacity:0;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}\n@keyframes boot-ripple{0%{opacity:0;transform:scale(1)}15%{opacity:.6}100%{opacity:0;transform:scale(1.7)}}\n@keyframes boot-failsafe{to{opacity:0;visibility:hidden}}\n@media not all and (display-mode:standalone){#boot-screen{display:none}}\n@media (prefers-reduced-motion:reduce){#boot-screen .boot-logo{animation:none}#boot-screen .boot-glow,#boot-screen .boot-ring{display:none}}';

const BOOT_LOGO =
  '<svg class="boot-logo" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 96 96"><path fill="url(#boot-grad-0)" fill-rule="evenodd" d="M48 96C74.5097 96 96 74.5097 96 48C96 21.4903 74.5097 0 48 0C21.4903 0 0 21.4903 0 48C0 74.5097 21.4903 96 48 96ZM80.0001 52C80.0001 67.464 67.4641 80 52.0001 80C36.5361 80 24.0001 67.464 24.0001 52C24.0001 49.1303 24.4318 46.3615 25.2338 43.7548C27.4288 48.6165 32.3194 52 38.0001 52C45.7321 52 52.0001 45.732 52.0001 38C52.0001 32.3192 48.6166 27.4287 43.755 25.2337C46.3616 24.4317 49.1304 24 52.0001 24C67.4641 24 80.0001 36.536 80.0001 52Z" clip-rule="evenodd"/><path fill="#131928" fill-rule="evenodd" d="M80.0002 52C80.0002 67.464 67.4642 80 52.0002 80C36.864 80 24.5329 67.9897 24.017 52.9791C24.0057 53.318 24 53.6583 24 54C24 70.5685 37.4315 84 54 84C70.5685 84 84 70.5685 84 54C84 37.4315 70.5685 24 54 24C53.6597 24 53.3207 24.0057 52.9831 24.0169C67.9919 24.5347 80.0002 36.865 80.0002 52Z" clip-rule="evenodd" opacity=".2"/><path fill="url(#boot-grad-1)" fill-rule="evenodd" d="M48 12C28.1177 12 12 28.1177 12 48C12 50.2091 10.2091 52 8 52C5.79086 52 4 50.2091 4 48C4 23.6995 23.6995 4 48 4C50.2091 4 52 5.79086 52 8C52 10.2091 50.2091 12 48 12Z" clip-rule="evenodd"/><defs><linearGradient id="boot-grad-0" x1="48" x2="117.5" y1="0" y2="69.5" gradientUnits="userSpaceOnUse"><stop stop-color="#C395FC"/><stop offset="1" stop-color="#4F65F5"/></linearGradient><linearGradient id="boot-grad-1" x1="28" x2="28" y1="8" y2="48" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".4"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>';

const BootScreen = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: BOOT_CSS }} />
    <div id="boot-screen" aria-hidden="true">
      <div className="boot-mark">
        <div className="boot-glow" />
        <div className="boot-ring" />
        <div className="boot-ring boot-ring-2" />
        <div
          style={{ position: 'absolute', inset: 0 }}
          dangerouslySetInnerHTML={{ __html: BOOT_LOGO }}
        />
      </div>
    </div>
  </>
);

/** Fades the startup screen out once the app is ready, then removes it. */
export const dismissBootScreen = (): (() => void) => {
  const boot = document.getElementById('boot-screen');

  if (!boot) {
    return () => undefined;
  }

  boot.classList.add('boot-done');
  const timer = window.setTimeout(() => boot.remove(), 400);

  return () => window.clearTimeout(timer);
};

export default BootScreen;
