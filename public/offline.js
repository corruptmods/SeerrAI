const title = document.getElementById('title');
const detail = document.getElementById('detail');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
const reason = document.getElementById('reason');

// What actually went wrong, so whoever looks knows where to look:
// this device's connection, Cloudflare, the proxy, or Seerr itself.
const CLOUDFLARE = {
  520: 'Cloudflare got an answer from the server it didn’t understand.',
  521: 'Cloudflare reached the network, but nothing answered on the server.',
  522: 'Cloudflare couldn’t connect to the server in time.',
  523: 'Cloudflare couldn’t find a route to the server.',
  524: 'Cloudflare connected, but the server took too long to answer.',
  525: 'Cloudflare couldn’t set up a secure connection to the server.',
  526: 'Cloudflare didn’t accept the server’s certificate.',
  527: 'Cloudflare couldn’t reach the server through its tunnel.',
  530: 'Cloudflare couldn’t reach the server.',
};
const explain = (why) => {
  if (!why) return '';
  if (why === 'network') {
    return 'Your browser couldn’t connect at all. That points at the connection between this device and the server (DNS, Wi-Fi, a VPN), not at Seerr AI.';
  }
  if (why === 'timeout') {
    return 'The address answered nothing in time. The server, or something on the way to it, is not answering.';
  }
  const code = Number(String(why).replace('status:', ''));
  if (CLOUDFLARE[code]) return `${CLOUDFLARE[code]} (${code})`;
  if (code >= 502 && code <= 504) {
    return `The proxy in front of Seerr AI couldn’t get an answer from it. (${code})`;
  }
  return code ? `The server answered with an error. (${code})` : '';
};
const showReason = (why) => {
  const text = explain(why);
  reason.hidden = !text;
  if (text) {
    reason.innerHTML = '';
    const label = document.createElement('strong');
    label.textContent = 'What happened: ';
    reason.append(label, text, ` · ${new Date().toLocaleTimeString()}`);
  }
};

// Say which problem it is: this device offline, or the server down.
const describe = () => {
  if (navigator.onLine === false) {
    title.textContent = 'You’re offline';
    detail.textContent =
      'Check your connection. Seerr AI will reload as soon as you’re back online.';
  } else {
    title.textContent = 'Can’t reach Seerr AI';
    detail.textContent =
      'The server isn’t responding. It may be restarting — this page will reconnect on its own.';
  }
};

// A small public endpoint rather than the page itself: asking for the
// page made a recovering server render it every couple of seconds.
const serverIsUp = async () => {
  const controller = new AbortController();
  const giveUp = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/v1/status', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) showReason(`status:${response.status}`);
    return response.ok;
  } catch (error) {
    showReason(error && error.name === 'AbortError' ? 'timeout' : 'network');
    return false;
  } finally {
    window.clearTimeout(giveUp);
  }
};

let delay = 3000;
let timer;

const check = async () => {
  window.clearTimeout(timer);
  if (await serverIsUp()) {
    status.textContent = 'Reconnected — loading';
    window.location.reload();
    return;
  }
  // Back off gently, up to every 15 seconds, so a long outage is not a
  // steady stream of requests.
  delay = Math.min(delay * 1.5, 15000);
  timer = window.setTimeout(check, delay);
};

retry.addEventListener('click', async () => {
  retry.disabled = true;
  status.textContent = 'Checking…';
  delay = 3000;
  await check();
  retry.disabled = false;
  status.textContent = 'Checking again automatically';
});

window.addEventListener('online', () => { describe(); check(); });
window.addEventListener('offline', describe);

describe();
showReason(document.documentElement.dataset.reason);
timer = window.setTimeout(check, delay);
