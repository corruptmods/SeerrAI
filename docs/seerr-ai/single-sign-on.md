# Single sign-on

[← Seerr AI guide](./README.md)

Single sign-on lets people sign in to Seerr AI with an account they already have somewhere else: an identity provider such as Authentik, Authelia, Keycloak, Pocket ID or Google. Instead of typing a password into Seerr AI, they press **Sign in with Authentik** (or whatever you named it), sign in there, and come straight back, signed in. It works through OpenID Connect, the standard all of these speak.

It sits beside the other ways in: Plex, Jellyfin and Emby, passwords and passkeys all keep working, and you can add several providers.

## Before you start

**Set the Application URL** in **Settings → General** to the address people use for Seerr AI, such as `https://seerr.example.com`. The provider sends people back to Seerr AI at that address, and it has to know the address in advance, so single sign-on stays off until it is set. People who open Seerr AI at another address (a LAN address, say) are taken to the Application URL to sign in.

The provider has to be reachable over **https**, from Seerr AI's server and from people's browsers. (Plain http is only accepted for a provider on the same machine as Seerr AI.)

## Adding a provider

In **Settings → Users → Single Sign-On**, press **Add Provider**:

1. Type a **Name**. It's on the button: "Sign in with {name}". The **Redirect URL** below it fills in by itself, for example `https://seerr.example.com/api/v1/auth/oidc/authentik/callback`. Copy it.
2. In your provider, make a client (an "application") for Seerr AI, using that redirect URL. The steps for each provider are below. Make it a **confidential** client: one with a client secret.
3. Back in Seerr AI, fill in the **Issuer URL**, **Client ID** and **Client Secret** the provider gave you, and press **Test**. Seerr AI asks the provider about itself and says plainly if something is wrong: a wrong address, a slash too many or too few at the end of the issuer URL, a provider that doesn't answer.
4. Leave **Scopes** as `openid profile email` unless you have a reason to change them (to let in only some people by their groups, some providers need `groups` added; see [Only let some people in](#only-let-some-people-in)), and press **Add Provider**.

The other settings:

- **Button Logo**: an https address of a small picture for the button. Optional.
- **Enabled**: whether the provider is offered at all. Switching it off keeps everything as it is, just unused.
- **Let New People Sign Up**: off by default. See [Who can sign in](#who-can-sign-in).
- **Who Can Sign In**: rules that keep the provider to some of its people, such as one group. Empty by default, which lets in anyone with an account there. See [Only let some people in](#only-let-some-people-in).

The client secret is never sent back to your browser. When you edit a provider, leave the secret blank to keep the saved one; it is only kept while the issuer URL stays the same, so a saved secret can never be sent to a different provider.

The part of the redirect URL after `oidc/` is the provider's id. It is made from the name when you add the provider and never changes, so renaming a provider doesn't break anything.

Changing a provider's **Issuer URL** is different: a new issuer is a different provider, even under the same name, and its ids for people mean nothing here. Everyone's links to the provider stop working (Linked Accounts shows them as **(not available)**), and each person signs in another way and links it again. The edit dialog warns you before you save. A slash at the end doesn't count as a change. To move to a new provider while the old one still works, add it as a new provider instead, and let people link it before you remove the old one.

## Who can sign in

People are recognised by their account at the provider, never by their email address.

- **Someone who already has an account here** links the provider to it first: they sign in the way they always have, open **Profile → Settings → Linked Accounts**, choose **Link Account → {provider}**, and sign in at the provider. From then on, the provider's button signs them in. An account at the provider can only be linked to one account here.
- **Someone new**, with no account here, is turned away with a message, unless **Let New People Sign Up** is on. Then they get an account of their own, with the default permissions and request limits from **Settings → Users**, named as the provider names them. Their email comes along only when the provider says it has checked it (the `email_verified` claim) and nobody here has it yet; otherwise their account starts with a stand-in they can replace with a real address in their profile.
- **A new person whose email belongs to an account here** is turned away and told to sign in with their existing account and link the provider in their profile. Seerr AI never joins two accounts because their emails match: anyone can put any email address on an account at some providers.

Turn **Let New People Sign Up** on only for a provider whose users you would all let in. With Google, that would be anyone with a Google account, unless your Google app is limited to your own users (see below).

A provider sign-in is enough on its own: it doesn't also ask the media server, as signing in with a password does.

Someone who signs in with a provider can add a passkey in their profile, and it keeps working when password sign-in is switched off in **Settings → Users**.

## Only let some people in

Your provider may have people on it who shouldn't use Seerr AI: everyone at work, say, or every account on a Google Workspace. **Who Can Sign In**, in the provider's settings, keeps the provider to the people you choose, by what the provider says about them when they sign in. Those details are called claims: `groups` (the groups someone is in), `email`, `hd` (Google's Workspace domain), and so on.

Press **Add Rule** and fill in a **Claim** and, usually, a **Value**:

- **A claim and a value**: the claim must be exactly that value, or, when it is a list (as `groups` is), contain it. For example, the claim `groups` with the value `seerr-users` lets in only people in the `seerr-users` group. Capitals count: `Seerr-Users` is a different group.
- **A claim with no value**: the claim must be `true`. This suits a provider you've set up to send a yes/no claim of your own, such as `is_seerr_user`.

With several rules, someone has to pass every one of them. With none, anyone with an account on the provider can sign in (as long as they have an account here, or **Let New People Sign Up** is on).

The rules are checked every time: when someone signs in, when a new person would get an account, and when someone links the provider in **Profile → Settings → Linked Accounts**. Someone they turn away is told "Your {provider} account isn't allowed to use this server. Ask an admin if you think it should be.", and nothing changes for them here: no account is made and nothing is linked. Taking someone out of the group at the provider stops their next sign-in with it. It doesn't sign them out of a session they already have, and doesn't stop other ways in, such as a password.

Seerr AI reads claims from the ID token and from the provider's userinfo, so a claim the provider sends in either place counts. If the provider has rules and its userinfo can't be read, nobody is let in with it until it can.

**Settings → Logs** says which claims someone failed, by name only, never what their claims were.

How each provider sends groups:

- **Authentik** sends `groups`, the names of the groups someone is in, with the `profile` scope, which is in the scopes Seerr AI asks for anyway. Use the group's name as the value.
- **Authelia** sends `groups` with the `groups` scope. Add `groups` to the client's `scopes` in Authelia's configuration, and to **Scopes** in Seerr AI (`openid profile email groups`).
- **Keycloak** sends groups through a **Group Membership** mapper: add one to the client, with `groups` as its token claim name. With **Full group path** on (the default), a group is sent as its path, such as `/family/seerr-users`, and that whole path is the value; turn it off to send just the name, `seerr-users`. The mapper adds the claim to the ID token and to userinfo unless you turn those off; either one is enough.
- **Pocket ID** sends `groups`, the names of the groups someone is in, with the `groups` scope. Add `groups` to **Scopes** in Seerr AI (`openid profile email groups`), and use the group's name, not its friendly name, as the value.
- **Google** has no groups. To let in only your Google Workspace, use the claim `hd` with your Workspace's domain, such as `example.com`, as the value. Accounts outside a Workspace (ordinary Gmail accounts) have no `hd`, so they're turned away.

Upstream Seerr's `requiredClaims` (claim names separated by spaces, each of which must be `true`) is understood too: a provider pasted from its `settings.json` with `"requiredClaims": "is_seerr_user"` works the same here, and shows as a rule with no value.

## Linking and unlinking

**Profile → Settings → Linked Accounts** lists each provider someone has linked, beside their media server accounts. A link can be removed while its owner still has another way in: a password, an account on a connected media server, or another provider that is switched on. Admins who manage users can remove someone's link too, for example when their account at the provider is replaced.

When a provider is switched off or removed, people's links to it stay, shown as **(not available)**, and can't be used to sign in. They can always be removed. A provider added later never takes them over: its id is always a new one. The same goes for links made before a provider's issuer URL changed; linking it again replaces the old link.

## Signing out

Signing out of Seerr AI signs you out of Seerr AI only. You stay signed in at the provider, so the next **Sign in with …** may not ask for your password at all. To sign out everywhere, sign out at the provider too.

## Setting up each provider

Wherever a step asks for the redirect URL, paste the one shown in Seerr AI. The examples use `https://seerr.example.com` for Seerr AI and a provider named so that its id matches.

### Authentik

1. **Applications → Applications → Create with provider**. Name it "Seerr AI", choose **OAuth2/OpenID Provider**.
2. **Client type: Confidential**. Under **Redirect URIs/Origins**, add the redirect URL (strict). Pick a **Signing Key** (the self-signed certificate is fine).
3. Finish, then open the provider: it shows the **Client ID**, **Client Secret** and **OpenID Configuration Issuer**, such as `https://auth.example.com/application/o/seerr-ai/`. Use that issuer exactly, with the slash at the end.

### Authelia

Add a client to `identity_providers.oidc.clients` in Authelia's configuration, and restart it:

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

In Seerr AI, the issuer URL is Authelia's own address, such as `https://auth.example.com`, and the client secret is the random password the command printed (not the digest).

### Keycloak

1. In your realm, **Clients → Create client**. **Client type: OpenID Connect**, **Client ID** `seerr-ai`.
2. Turn **Client authentication** on (that makes it confidential) and keep **Standard flow** on.
3. Under **Valid redirect URIs**, add the redirect URL, and save.
4. The **Credentials** tab has the client secret. The issuer URL is `https://sso.example.com/realms/your-realm` (on Keycloak before version 17, `https://sso.example.com/auth/realms/your-realm`).

### Pocket ID

1. **Administration → OIDC Clients → Add OIDC Client**. Name it "Seerr AI" and add the redirect URL under **Callback URLs**. Leave **Public Client** off.
2. Save. Pocket ID shows the **Client ID** and **Client Secret** (copy the secret now: it may not be shown again).
3. The issuer URL is Pocket ID's own address, such as `https://id.example.com`.

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/), choose or make a project and set up its **OAuth consent screen** (Google Auth Platform → Branding and Audience). For your own users only, choose **Internal** (Google Workspace), or keep the app in **Testing** and add each person as a test user.
2. **Clients → Create client → Web application**. Under **Authorized redirect URIs**, add the redirect URL. Google only accepts https addresses here.
3. Create it, and copy the client ID and secret. The issuer URL is `https://accounts.google.com`.

## When something goes wrong

- **The Test button says the provider gives a different issuer URL**: enter exactly the one it names. A slash at the end counts.
- **"No sign-in details were found at that address"**: the issuer URL is wrong. Seerr AI reads `/.well-known/openid-configuration` under it; opening that address in a browser should show a page of JSON.
- **"That took too long, or was started in another window"**: signing in has to finish within ten minutes, in the same browser it was started in. It also shows when the provider sends people back to a different address than the Application URL they started from.
- **"Something went wrong with {provider}"**: often a client secret or redirect URL that doesn't match the provider's. **Settings → Logs** says more; it never shows secrets, codes or tokens.
- **"Your {provider} account isn't allowed to use this server"**: the provider's rules under **Who Can Sign In** turned them away. **Settings → Logs** names the claims they failed. Often the provider isn't sending the claim at all: check the scopes (see [Only let some people in](#only-let-some-people-in)) and that the value matches exactly, capitals included.
- **"Too many attempts"**: after ten failed attempts from one address, that provider is refused there for up to fifteen minutes. A sign-in the rules turn away counts as a failed attempt. Only sign-ins started from Seerr AI's own sign-in page or Linked Accounts count, so nobody can lock others out by sending made-up sign-in links. Behind a reverse proxy, turn on **Enable Proxy Support** in **Settings → Network**, so each person's own address is counted rather than the proxy's.
