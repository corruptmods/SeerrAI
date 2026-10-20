---
title: Email
description: Configure email notifications for your users.
sidebar_position: 1
---

# Email

## Configuration

:::info
If the [Application URL](../settings/general.md#application-url) setting is configured in **Settings → General**, Seerr will explicitly set the origin server hostname when connecting to the SMTP host.
:::

### Embed Poster

Emails about a film, series or album show its poster (or the album's cover) beside the text, with a faded copy behind it. It's on unless you turn it off.

The picture comes straight from TMDB (or the Cover Art Archive for music), not from your server, so it shows even when Seerr AI can't be reached from outside your home. Some email apps hide pictures until the reader chooses to show them.

### Use public Seerr AI logo instead of instance logo

Every email starts with Seerr AI's logo. Normally the email asks your own server for it, at your Application URL, so the logo only shows when the reader's email app can reach that address. If Seerr AI is only reachable at home, people reading their email anywhere else get a missing picture.

Turn this on to use the copy of Seerr AI's logo kept in Seerr AI's repository on GitHub instead, which loads from anywhere. It's off unless you turn it on. With it off and no Application URL set, emails show your Application Title in large letters instead of a logo.

The logo is a PNG picture, which every email app can show. An email app that hides pictures until the reader chooses to show them usually shows your Application Title in its place. The **Test** button uses the choice on the page, so you can try it before you save.

### Require User Email

When enabled, users will be required to provide a valid email address in their user settings. This is useful if you want to ensure all users can receive email notifications.

### Sender Name (optional)

Configure a friendly name for the email sender. On a new server it starts as "Seerr AI".

### Sender Address

Set this to the email address you would like to appear in the "from" field of the email message.

Depending on your email provider, this may need to be an address you own. For example, Gmail requires this to be your actual email address.

### SMTP Host

Set this to the hostname or IP address of your SMTP server.

### SMTP Port

Set this to a supported port number for your SMTP host. `465` and `587` are commonly used.

### Encryption Method

In most cases, [Use Implicit TLS](https://tools.ietf.org/html/rfc8314) should be selected for port 465, and [Use STARTTLS](https://en.wikipedia.org/wiki/Opportunistic_TLS) if available for port 587. Please refer to your email provider's documentations for details on how to configure this setting.

The default value for this setting is **Use STARTTLS if available**. The four choices are:

- **None**: never encrypts. Your SMTP password and every email cross the network as plain text, so only use this for a mail server on the same machine or your own network that can't encrypt.
- **Use STARTTLS if available**: encrypts when the mail server offers it, and sends without encryption when it doesn't.
- **Always use STARTTLS**: like the one above, but refuses to send at all if the mail server doesn't offer encryption. A safer choice for port 587.
- **Use Implicit TLS**: encrypts from the very start of the connection, usually on port 465.

### Allow Self-Signed Certificates

When Seerr AI sends email with encryption, it checks the mail server's certificate. That check is what proves it's talking to your mail server and not to something pretending to be it. A mail server that made its own certificate (common for one running at home) fails the check, and emails don't send.

Turning this on skips the check for your mail server. It's off unless you turn it on. The catch is that the check is skipped completely: an expired certificate, or one made out to a different name, is accepted too, so anything that can get between Seerr AI and the mail server could read your SMTP password and the emails. Only use it for a mail server on your own network. For one on the internet, give it a proper certificate instead (Let's Encrypt's are free). It makes no difference with the Encryption Method set to **None**.

### SMTP Username & Password

:::info
If your account has two-factor authentication enabled, you may need to create an application password instead of using your account password.
:::
Configure these values as appropriate to authenticate with your SMTP host.

### PGP Private Key & Password (optional)

Configure these values to enable encrypting and signing of email messages using [OpenPGP](https://www.openpgp.org/). Note that individual users must also have their **PGP public keys** configured in their user settings in order for PGP encryption to be used in messages addressed to them.

When configuring the PGP keys, be sure to keep the entire contents of the key intact. For example, private keys always begin with `-----BEGIN PGP PRIVATE KEY BLOCK-----` and end with `-----END PGP PRIVATE KEY BLOCK-----`.
