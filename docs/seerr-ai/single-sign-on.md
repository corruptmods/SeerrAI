# Single sign-on

[← Seerr AI guide](./README.md)

Single sign-on lets people sign in with an account they already have at an identity provider, such as Authentik, Authelia, Keycloak, Pocket ID or Google. It uses OpenID Connect. Plex, Jellyfin, Emby, passwords and passkeys keep working beside it.

## Signing in with a provider

Once an admin has added a provider, the sign-in page shows its button under **Or sign in with** (for example **Authentik**).

1. Press the provider's button.
2. Sign in at the provider.
3. You come straight back, signed in.

The first time, your account here has to be linked to the provider (below), unless your admin lets new people sign up with it.

### Linking a provider to your account

1. Sign in the way you always do.
2. Open **Profile → Settings → Linked Accounts**.
3. Press **Link Account** and choose the provider.
4. Sign in at the provider. You're brought back to Linked Accounts, which says it's linked.

From then on the provider's button signs you in. One account at the provider links to one account here.

### When it says no

- **"No account here is linked to this … account"**: link it first (above), or ask an admin for an account.
- **"Another account here already has the email of this … account"**: sign in with that account, then link the provider.
- **"Your … account isn't allowed to use this server"**: the admin only lets some people in. Ask them if you should be.
- **"That took too long, or was started in another window"**: start again, and finish within ten minutes in the same browser.
- **"Too many attempts"**: wait a few minutes.

### Unlinking

In **Linked Accounts**, press **Delete** beside the provider, then confirm.

There's no **Delete** while the provider is your only way in. Set a password (**Profile → Settings → Password**) or link another account first. A provider that is switched off or removed shows **(Not available)**: it can't sign you in, and you can always delete it.

### Signing out

**Sign Out** signs you out of Seerr AI only. You stay signed in at the provider, so the next sign-in may not ask for your password. To sign out everywhere, also sign out at the provider.

## Setting it up (admins)

### Before you start

- **Settings → General → Application URL** must be the address people use, such as `https://seerr.example.com`. Single sign-on stays off until it's set. People who open Seerr AI at another address are sent there to sign in.
- The provider must be reachable over https from Seerr AI's server and from people's browsers. Plain http works only for a provider on the same machine.

### Adding a provider

1. **Settings → Users → Single Sign-On → Add Provider**.
2. Type a **Name**. The button says it; the **Redirect URL** below fills in from it (`…/api/v1/auth/oidc/<id>/callback`). Copy it.
3. In the provider, make a **confidential** client (one with a secret) for Seerr AI, with that redirect URL. Steps for each provider are [below](#each-provider).
4. Back here, fill in **Issuer URL**, **Client ID** and **Client Secret**.
5. Press **Test**. It checks the provider and says plainly what's wrong.
6. Press **Add Provider**.

You can paste the provider's whole configuration address (ending in `/.well-known/openid-configuration`) as the issuer URL; it's turned back into the issuer.

The other settings:

- **Scopes**: leave `openid profile email` unless a provider needs `groups` for [Who Can Sign In](#who-can-sign-in).
- **Button Logo**: an https address of a small picture. Optional.
- **Enabled**: off keeps the provider but hides it.
- **Let New People Sign Up**: off by default. See [New people](#new-people).
- **Who Can Sign In**: rules on what the provider says about someone. Empty lets everyone with a provider account in.

Catches:

- The secret is never sent back to the browser. Leave it blank when editing to keep it. It's dropped if you change the issuer URL.
- The provider's id (the part of the redirect URL after `oidc/`) is made once from the name. Renaming is safe.
- **Changing the Issuer URL** makes it a different provider: everyone's links stop working and people link again. The dialog warns you. A slash at the end doesn't count. To move providers gently, add the new one beside the old, let people link it, then remove the old.

### New people

People are matched by their account at the provider, never by email.

- **With Let New People Sign Up off** (the default), someone with no linked account here is turned away and told to link it or ask an admin.
- **With it on**, they get an account with the default permissions and limits from **Settings → Users**. Their email comes along only if the provider has verified it and nobody here has it; otherwise they add one in their profile.
- An email that belongs to an account here is never joined to it: they're told to sign in and link instead.

Turn sign-up on only for a provider whose users you'd all let in. For Google, that's anyone with a Google account unless you limit it (below).

A provider sign-in doesn't also ask the media server. Someone who signs in with a provider can add a passkey, which works even with password sign-in off.

### Who Can Sign In

Rules keep a provider to some of its people, using the claims it sends: `groups`, `email`, `hd` (Google Workspace) and so on.

1. In the provider's settings, press **Add Rule**.
2. Enter a **Claim**, and usually a **Value**.

- **Claim and value**: the claim must equal the value, or contain it when it's a list. `groups` = `seerr-users` lets in that group only. Capitals count.
- **Claim with no value**: the claim must be `true`, for a yes/no claim you set up yourself.

With several rules, someone must pass all of them. Rules are checked at every sign-in, sign-up and link. Taking someone out of the group stops their next sign-in with the provider, not a session they already have or other ways in. **Settings → Logs** names the claims someone failed, never their values. If the provider has rules and its userinfo can't be read, nobody gets in with it.

How each provider sends groups:

- **Authentik**: `groups` with the `profile` scope. The value is the group's name.
- **Authelia**: add `groups` to the client's scopes in Authelia and to **Scopes** here.
- **Keycloak**: add a **Group Membership** mapper with token claim name `groups`. With **Full group path** on, the value is the path (`/family/seerr-users`).
- **Pocket ID**: add `groups` to **Scopes**. Use the group's name, not its friendly name.
- **Google**: no groups. Use `hd` with your Workspace domain (`example.com`); plain Gmail accounts have no `hd`.

A provider copied from upstream Seerr's `settings.json` with `requiredClaims` works too: each name becomes a rule with no value.

### Removing a link or a provider

Admins who manage users can delete someone's link in their **Linked Accounts**. Deleting a provider (**Delete Provider**) keeps people's links but makes them unusable; a provider added later never takes them over.

## Each provider

Paste the redirect URL Seerr AI shows wherever a step asks for it. The examples use `https://seerr.example.com`.

### Authentik

1. **Applications → Applications → Create with provider**. Name it "Seerr AI", choose **OAuth2/OpenID Provider**.
2. **Client type: Confidential**. Add the redirect URL under **Redirect URIs/Origins** (strict). Pick a **Signing Key**.
3. Finish, then open the provider. Copy the **Client ID**, **Client Secret** and **OpenID Configuration Issuer** (`https://auth.example.com/application/o/seerr-ai/`).

The provider must be attached to an application, or Authentik answers 404. **Create with provider** does that. A provider made on its own under **Applications → Providers** needs **Applications → Applications → Create** with it picked.

### Authelia

Add a client to Authelia's configuration and restart it:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'seerr-ai'
        client_name: 'Seerr AI'
        # A digest of the secret, from:
        # authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986
        client_secret: '$pbkdf2-sha512$310000$...'
        public: false
        authorization_policy: 'two_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://seerr.example.com/api/v1/auth/oidc/authelia/callback'
        scopes: ['openid', 'profile', 'email']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_basic'
```

The issuer URL is Authelia's address (`https://auth.example.com`). The client secret is the random password the command printed, not the digest.

### Keycloak

1. In your realm, **Clients → Create client**: **OpenID Connect**, client ID `seerr-ai`.
2. Turn on **Client authentication**; keep **Standard flow** on.
3. Add the redirect URL under **Valid redirect URIs** and save.
4. The secret is on the **Credentials** tab. The issuer URL is `https://sso.example.com/realms/your-realm` (before Keycloak 17: `…/auth/realms/your-realm`).

### Pocket ID

1. **Administration → OIDC Clients → Add OIDC Client**. Name it, add the redirect URL under **Callback URLs**, leave **Public Client** off.
2. Save, and copy the **Client ID** and **Client Secret** (the secret may not be shown again).
3. The issuer URL is Pocket ID's address (`https://id.example.com`).

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/), set up the project's **OAuth consent screen**. For your own people only, choose **Internal** (Workspace), or keep it in **Testing** with each person added as a test user.
2. **Clients → Create client → Web application**. Add the redirect URL under **Authorized redirect URIs** (https only).
3. Copy the client ID and secret. The issuer URL is `https://accounts.google.com`.

## When something goes wrong

- **Test says the provider gives a different issuer URL**: enter exactly the one it names.
- **"No sign-in details were found at that address"**: the issuer URL is wrong. Opening `<issuer>/.well-known/openid-configuration` in a browser should show JSON. Authentik keeps it under each application (`/application/o/<app slug>/`).
- **"That took too long, or was started in another window"**: also shown when the provider sends people back to a different address than the Application URL.
- **"Something went wrong with …"**: usually a secret or redirect URL that doesn't match. **Settings → Logs** says more, without secrets.
- **"Your … account isn't allowed to use this server"**: a Who Can Sign In rule turned them away. Check the scopes and the exact value.
- **"Too many attempts"**: ten failed attempts from one address lock that provider there for up to fifteen minutes. Only sign-ins started from Seerr AI count, so made-up links can't lock others out. Behind a reverse proxy, turn on **Enable Proxy Support** (Settings → Network) so each person's address is counted.
