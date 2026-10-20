---
title: Network
description: Configure Network settings.
sidebar_position: 7
---

# Network

Network-related settings are available in the **Network** tab under **Settings**. These options control how Seerr communicates with external services

## DNS Caching

Seerr allows you to enable DNS caching if you are experiencing DNS-related issues. When enabled, it improves performance and reduces the number of DNS lookups required for external API calls. This can help speed up response times and reduce the load on DNS servers, especially when a local resolver like Pi-hole is used.

### Configuration

You can enable the DNS caching settings in the Network tab of the Seerr settings. The default values follow the standard DNS caching behavior.

- **Force Minimum TTL**: Set a minimum time-to-live (TTL) in seconds for DNS cache entries. This ensures that frequently accessed DNS records are cached for a longer period, reducing the need for repeated lookups. Default is 0.
- **Force Maximum TTL**: Set a maximum time-to-live (TTL) in seconds for DNS cache entries. This prevents infrequently accessed DNS records from being cached indefinitely, allowing for more up-to-date information to be retrieved. Default is -1 (unlimited).

## Force IPv4 resolution first

Sometimes there are configuration issues with IPv6 that prevent the hostname resolution from working correctly.

You can force resolution to prefer IPv4 by going to `Settings > Network`, enabling `Force IPv4 Resolution First`, and then restarting Seerr.

## HTTP(S) Proxy

If you can't change your DNS servers or force IPV4 resolution, you can use Seerr through a proxy. It carries all of Seerr AI's outgoing HTTP and HTTPS requests; it doesn't set up HTTPS, SSL or certificates for Seerr AI itself.

In some places (like China), the ISP blocks not only the DNS resolution but also the connection to the TMDB API.

## Enable Proxy Support

If you have Seerr behind a reverse proxy, enable this setting to allow Seerr to correctly register client IP addresses. For details, please see the [Express Documentation](https://expressjs.com/en/guide/behind-proxies.html).

Seerr AI only takes the address from a proxy it trusts. Always trusted are proxies on the same machine, on your local network and on Tailscale (loopback, link-local and private addresses such as `10.x.x.x`, `172.16.x.x`–`172.31.x.x`, `192.168.x.x` and `fc00::/7`, and `100.64.0.0/10`, where Tailscale and carrier-grade NAT give out addresses and which nobody on the internet can connect from), which is where a reverse proxy (Nginx, Caddy or Traefik in Docker, say) or a Docker network sits. The address used is the last one a trusted proxy added, so nobody can choose their own by sending a made-up `X-Forwarded-For` header: the sign-in attempt limits count by address.

A proxy on a public address in front of your reverse proxy is only trusted if you say so, under the switch:

- **Cloudflare Tunnel** needs nothing: the tunnel connects from your own machine or network.
- **Cloudflare's proxy** (the orange cloud in front of your reverse proxy): tick **Trust Cloudflare**. Seerr AI then trusts [Cloudflare's published addresses](https://cloudflare.com/ips).
- **Any other proxy on a public address**, such as a reverse proxy on a rented server: list its address or range (`203.0.113.5`, `203.0.113.0/24`, `2001:db8::/32`) under **Also Trust These Proxies**, separated by commas or spaces.

Without that, Seerr AI sees the public proxy's address for everyone. Having your local reverse proxy put the visitor's real address in `X-Forwarded-For` still works too (in Nginx, the `real_ip` module with the public proxy's addresses as `set_real_ip_from`).

Changes to these take effect after Seerr AI restarts.

This setting is **disabled** by default.

## Enable CSRF Protection

:::warning
**This is an advanced setting.** Please only enable this setting if you are familiar with CSRF protection and how it works.
:::

CSRF stands for [cross-site request forgery](https://en.wikipedia.org/wiki/Cross-site_request_forgery). With this on, every change made from a browser must carry a token Seerr AI gave that browser, so another website can't make your signed-in browser change things.

Apps and scripts that use an API key (the server's, or a [personal one](../../seerr-ai/account.md#api-keys)) in the `X-Api-Key` header are not affected: they never use the browser's sign-in, so they need no token and can still make changes. A wrong key is always refused.

The token's cookie is only sent over HTTPS, so with this on you can no longer use Seerr AI from a browser over plain _HTTP_ (including an IP address and port).

It takes effect after Seerr AI restarts. If you turn it on and can't get in, turn it off again by setting `csrfProtection` to `false` under `network` in `settings.json` in `/app/config`, and restart.

This setting is **disabled** by default.

## API Request Timeout

The API Request Timeout setting defines the maximum time (in seconds) Seerr will wait for a response from external services, such as Radarr or Sonarr. The default value is 10 seconds, though it can be entirely disabled by setting it to 0. Please note that any changes to this value require restarting Seerr to take effect.

Enforcing a timeout ensures the Seerr interface remains responsive and prevents infinite loading states when a connected service unexpectedly goes offline. Conversely, you may want to increase this value if you frequently experience failed requests due to your external services being slow to respond, which often happens when they are under heavy load or querying network-mounted storage.
