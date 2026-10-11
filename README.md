# Directus Magic Link

Passwordless sign-in for Directus 11 and 12. The users of your website enter their email, receive a link, open it, and are signed in with normal Directus tokens. The extension follows the same rules as `POST /auth/login`.

- [What it does](#what-it-does)
- [Getting started](#getting-started)
  - [1. Install](#1-install)
  - [2. Configure Directus](#2-configure-directus)
  - [3. The sign-in form](#3-the-sign-in-form)
  - [4. The callback page](#4-the-callback-page)
- [What users are told](#what-users-are-told)
- [Custom rules](#custom-rules)
- [Emails and localization](#emails-and-localization)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Built-in pages for Data Studio users](#built-in-pages-for-data-studio-users)
- [Going to production](#going-to-production)
- [Troubleshooting](#troubleshooting)
- [Differences from `/auth/login`](#differences-from-authlogin)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## What it does

- **Follows the core login rules.** Only `active` users can sign in, just like `/auth/login`. Every rule is checked again when the link is used, so suspending a user cancels any link they already have. Users with 2FA must also enter their authenticator code.
- **Issues real Directus sessions.** Tokens come from `AuthenticationService.refresh()`. That means policies, the license lock, `auth.jwt` filters, `REFRESH_TOKEN_TTL` / `SESSION_COOKIE_*` and `/auth/refresh` / `/auth/logout` all work as usual. Each login is written to the activity log.
- **Sends mail through Directus.** It uses Directus' `MailService`, so your `EMAIL_TRANSPORT`, `email.send` hooks and email rate limits all apply. Emails are Liquid templates, can have their own sender (`MAGIC_LINK_EMAIL_FROM`), and are localized (`en-US` and `fr-FR` built in).
- **Tells users what they need to know, and nothing more.** The sign-in form never reveals whether an account exists. Once someone opens a link, they get a clear reason if it can't be used. See [What users are told](#what-users-are-told).
- **Lets you add rules.** Allow/deny email lists and role lists, plus a `magic-link.validate` hook to add your own rules or skip the built-in ones.
- **Secure by default.**
  - Tokens are 256-bit and single-use, and are stored only as SHA-256 hashes.
  - Newer links cancel older ones.
  - Requests are rate-limited per email and per IP.
  - Links only ever go to allow-listed pages.

## Getting started

The examples use Directus at `https://admin.example.com` and your website at `https://example.com`.

### 1. Install

Install the extension like any other Directus extension: see [Including extensions](https://directus.com/docs/self-hosting/including-extensions) in the Directus docs. To build it from source, run `pnpm install && pnpm build`; the build goes to `dist/`.

To install it from the Directus Marketplace, set `MARKETPLACE_TRUST=all`. The extension signs users in through Directus' own services and database, so it can't run in the extension sandbox, and with the default `MARKETPLACE_TRUST=sandbox` the Marketplace only offers sandboxed extensions.

On startup the extension creates its table, `extension_magic_link`, which holds the tokens and an audit trail of every request. No migration is needed.

### 2. Configure Directus

```bash
# Directus' own address, NOT your website's
PUBLIC_URL=https://admin.example.com

# The page on your website that emails link to. Only allow-listed pages are ever used.
MAGIC_LINK_URL_ALLOW_LIST=https://example.com/auth/magic

# Let your website call Directus from the browser
CORS_ENABLED=true
CORS_ORIGIN=https://example.com
```

**Why `PUBLIC_URL` is the Directus address.** `PUBLIC_URL` is always where Directus itself runs. Directus uses it for its own URLs, such as the project logo in emails. The link in a magic-link email doesn't come from `PUBLIC_URL`. It comes from the `redirect_url` your sign-in form sends, so users land on `https://example.com/auth/magic?token=…`, on your website. Sign-in through your website works even if `PUBLIC_URL` is left at Directus' default (`/`); emails then go out without the logo.

**Email.** If Directus can already send password-reset emails, there's nothing to do. Otherwise [set up Directus email](https://directus.com/docs/configuration/email) first. To give magic-link emails their own sender:

```bash
MAGIC_LINK_EMAIL_FROM="Example <login@example.com>"
```

**Cookies.** `admin.example.com` and `example.com` are the same site, so Directus' default cookie settings work. `CORS_CREDENTIALS` is already `true` by default. Only if Directus is on a different site entirely (for example `example.com` and `example-cms.io`) do you also need:

```bash
SESSION_COOKIE_SAME_SITE=None
SESSION_COOKIE_SECURE=true
```

Use the same two settings with the `REFRESH_TOKEN_COOKIE_` prefix if you use `mode: "cookie"`.

### 3. The sign-in form

```js
async function requestMagicLink(email) {
	const res = await fetch('https://admin.example.com/magic-link/request', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, redirect_url: 'https://example.com/auth/magic' }),
	});

	if (res.status === 429) return 'too-many-attempts'; // Retry-After says when to try again
	if (res.status === 400) throw new Error((await res.json()).errors[0].message);
	return 'check-your-inbox';
}
```

After a `204`, always show the same message, for example _"Check your inbox"_. The API gives the same answer whether or not the account exists. See [What users are told](#what-users-are-told).

### 4. The callback page

This is the page at `https://example.com/auth/magic`, which the email links to with `?token=…`.

```js
const url = new URL(location.href);
const token = url.searchParams.get('token');

// Take the token out of the address bar and browser history straight away
url.searchParams.delete('token');
history.replaceState(null, '', url);

async function verify(otp) {
	const res = await fetch('https://admin.example.com/magic-link/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ token, mode: 'session', otp }),
	});

	if (res.ok) return 'SIGNED_IN';
	return (await res.json()).errors?.[0]?.extensions?.code;
}

switch (await verify()) {
	case 'SIGNED_IN':
		break; // the user is signed in
	case 'INVALID_OTP':
		break; // ask for the 2FA code, then call verify(code) with the SAME token
	case 'TOKEN_EXPIRED':
	case 'INVALID_TOKEN':
	case 'OTP_LIMIT_EXCEEDED':
		break; // "This link can't be used any more", and offer a new one
	case 'USER_SUSPENDED':
	case 'USER_INACTIVE':
	case 'FORBIDDEN':
		break; // "Your account can't sign in. Contact your administrator."
}
```

Once signed in, the user is authenticated exactly as if they had logged in with a password. With the Directus SDK, use its session mode:

```js
import { authentication, createDirectus, readMe, rest } from '@directus/sdk';

const client = createDirectus('https://admin.example.com')
	.with(authentication('session', { credentials: 'include' }))
	.with(rest({ credentials: 'include' }));

const me = await client.request(readMe());
```

Refreshing and signing out use the normal Directus endpoints (`POST /auth/refresh`, `POST /auth/logout`), or `client.refresh()` and `client.logout()` in the SDK.

`mode` works like it does for `POST /auth/login`:

| `mode`           | You get                                                             | Use it when                                                                              |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session`        | An httpOnly session cookie, and no tokens in JavaScript             | A browser app talking to Directus with `credentials: 'include'`. Recommended.            |
| `cookie`         | `access_token` in JSON, and the refresh token as an httpOnly cookie | You manage the access token yourself but want the refresh token out of reach of scripts. |
| `json` (default) | `access_token` and `refresh_token` in JSON                          | Server-side code, or native apps with secure storage.                                    |

Treat the token like a password until it's used:

- Don't log the callback URL on your server.
- Keep third-party scripts and analytics off the callback page, because they would see the full URL.
- Only call `/magic-link/verify` when a person has opened the page, never from a link preview or a service worker.

## What users are told

**When they ask for a link, the form never reveals anything about the account.** Anyone can type any address, so telling them "no such user" or "suspended" would let them find out who has an account. The API answers `204` in the same time for every address. What happens next depends on the account:

| Account                                 | Email sent                                                          |
| --------------------------------------- | ------------------------------------------------------------------- |
| Active and allowed                      | The sign-in link                                                    |
| Suspended, invited, draft or archived   | _"Your account isn't active. Contact your administrator."_, no link |
| Doesn't exist                           | Nothing, so the form can't be used to email strangers               |
| Refused by your rules or the rate limit | Nothing                                                             |

Only the owner of the mailbox learns why no link came. You can turn the inactive-account email off with `MAGIC_LINK_NOTIFY_INACTIVE=false`.

The one error the form does show is **too many attempts from the same IP** (`429`, with `Retry-After`). It's about the device, not the account, so it gives nothing away.

**When they open a link, the reason is specific.** Whoever holds the link has already proven they own the mailbox, so being clear hides nothing from anyone else:

| Code                 | Status | Meaning                                                                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `TOKEN_EXPIRED`      | 401    | The link is older than `MAGIC_LINK_TTL`.                                                          |
| `INVALID_TOKEN`      | 403    | The link was already used, was replaced by a newer one, or is wrong.                              |
| `USER_SUSPENDED`     | 401    | The account was suspended.                                                                        |
| `USER_INACTIVE`      | 401    | The account is no longer active (invited, draft or archived).                                     |
| `FORBIDDEN`          | 403    | Your rules or a hook refuse this account.                                                         |
| `INVALID_OTP`        | 401    | The 2FA code is missing or wrong. The link stays valid.                                           |
| `OTP_LIMIT_EXCEEDED` | 403    | Too many wrong 2FA codes (`MAGIC_LINK_MAX_OTP_ATTEMPTS`, 5 by default). The link no longer works. |

`TOKEN_EXPIRED`, `INVALID_TOKEN`, `USER_SUSPENDED`, `FORBIDDEN` and `INVALID_OTP` are Directus' own error codes. `USER_INACTIVE` and `OTP_LIMIT_EXCEEDED` are the extension's, because Directus has no error for these cases.

**Wrong 2FA codes are limited twice.** Each link stops working after `MAGIC_LINK_MAX_OTP_ATTEMPTS` wrong codes, even when they're sent simultaneously. Wrong codes since the user's last magic-link sign-in also count toward Directus' `auth_login_attempts` (25 by default): at that number the account is suspended, as with `/auth/login`. Requesting new links doesn't reset that count; only a successful sign-in does.

Admins can always see the exact reason in the `extension_magic_link` table.

## Custom rules

The checks run in this order, both when a link is requested and when it's used:

1. **Directus rules (can't be skipped).** The user must exist, have the status `active`, and use an allowed auth provider (`MAGIC_LINK_ALLOWED_PROVIDERS`, default `default`).
2. **The extension's rules.** These are the email allow/deny lists, the role lists and, when a link is requested, the per-email rate limit:

   ```bash
   MAGIC_LINK_EMAIL_ALLOW_LIST=@example.com,partner@other.io   # only these
   MAGIC_LINK_EMAIL_DENY_LIST=@mailinator.com                  # never these (wins over the allow list)
   MAGIC_LINK_ALLOWED_ROLES=<role id>,<role id>
   MAGIC_LINK_DISALLOWED_ROLES=<admin role id>
   ```

   Email patterns can be:
   - `jane@acme.com`: one address
   - `@acme.com`: a whole domain
   - `*.acme.com`: its subdomains
   - `qa+*@acme.com`: a wildcard
   - `/^ops-.*@acme\.com$/i`: a regular expression

3. **Your `magic-link.validate` hook.** It receives the decision from step 2. Return `{ allowed: false, reason }` or throw to refuse. Return `{ allowed: true }` to skip the step 2 rules. `meta.stage` is `"request"` or `"verify"`.

```js
// <EXTENSIONS_PATH>/magic-link-rules/index.js  (a hook extension)
export default (_register, { emitter }) => {
	emitter.onFilter('magic-link.validate', (decision, meta) => {
		if (meta.email.endsWith('@acme.com')) return { allowed: true }; // skip the lists, roles and rate limit
		if (meta.email.endsWith('@mailinator.com')) return { allowed: false, reason: 'disposable' };
		return decision;
	});
};
```

> Use **`emitter.onFilter`** from the hook's second argument. Directus sends events between extensions on a separate emitter, so the `filter()` helper from the first argument won't see them.

[examples/magic-link-rules](examples/magic-link-rules/index.js) is a complete hook you can copy. All events are listed in the [API reference](#events).

## Emails and localization

There are two emails: the sign-in link, and the inactive-account notice described in [What users are told](#what-users-are-told).

**Which language.** Emails use the user's `language` field. If it's empty ("project default" in the Data Studio), they use the project's `default_language`. Anything not set up falls back to `en-US`. A regional variant matches the shipped language, so `fr-CA` gets French. Both emails come built in, in `en-US` and `fr-FR`.

**Your own templates.** Copy [examples/templates/magic-link.liquid](examples/templates/magic-link.liquid) into `EMAIL_TEMPLATES_PATH` and edit it. Directus renders it itself, so `{% layout "base" %}` gives you the same layout as the password-reset email. For a `fr-FR` user, these files are tried in order, and the first one found is used:

1. `magic-link.fr-FR.liquid`
2. `magic-link.fr.liquid`
3. `magic-link.en-US.liquid`
4. `magic-link.en.liquid`
5. `magic-link.liquid`
6. the built-in template, in French

The inactive-account email is looked up the same way, as `magic-link-inactive.fr-FR.liquid`, `magic-link-inactive.liquid` and so on. To add German, add `magic-link.de-DE.liquid` (or `magic-link.de.liquid`).

**Subjects.** `MAGIC_LINK_EMAIL_SUBJECT` and `MAGIC_LINK_INACTIVE_EMAIL_SUBJECT` are either one Liquid string for every language, or a map per language. Languages missing from the map use its `en-US` entry, then the built-in translated subject.

```bash
MAGIC_LINK_EMAIL_SUBJECT='json:{"en-US": "Sign in to {{ projectName }}", "fr-FR": "Connexion à {{ projectName }}"}'
```

The `json:` prefix is Directus' own way of marking an env value as JSON. Without it, Directus splits values on commas. The extension joins them back, but the prefix is the reliable way.

**Template variables:**

- From your Directus settings: `projectName`, `projectColor`, `projectLogo`, `projectUrl`
- About the user: `email`, `user.id`, `user.email`, `user.first_name`, `user.last_name`, `user.language`, `ip`, `userAgent`
- About the link (sign-in email only): `url`, `expiresInMinutes`, `expiresAt`
- `locale`: the language the email is for, for example `fr-FR`
- `t`: the built-in translated strings, for example `{{ t.button }}` or `{{ t.expiry }}`
- Anything you add with the `magic-link.email` filter. The filter also receives `kind` (`link` or `inactive`) and can change `locale`.

## Configuration

| Variable                                                     | Default                  | Description                                                                                                         |
| ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `MAGIC_LINK_URL_ALLOW_LIST`                                  | —                        | Pages allowed as `redirect_url`. Works like `PASSWORD_RESET_URL_ALLOW_LIST`.                                        |
| `MAGIC_LINK_EMAIL_FROM`                                      | `EMAIL_FROM`             | Sender. `login@acme.com` or `Acme Login <login@acme.com>`.                                                          |
| `MAGIC_LINK_EMAIL_FROM_NAME`                                 | project name             | Sender name. A name other than the project name requires Directus 11.10+.                                           |
| `MAGIC_LINK_EMAIL_SUBJECT`                                   | built-in, translated     | Subject of the sign-in email: a Liquid string, or a map per language.                                               |
| `MAGIC_LINK_EMAIL_TEMPLATE`                                  | `magic-link`             | Template name in `EMAIL_TEMPLATES_PATH`, tried with language suffixes first. Falls back to the built-in template.   |
| `MAGIC_LINK_NOTIFY_INACTIVE`                                 | `true`                   | Email users whose account isn't active instead of sending nothing.                                                  |
| `MAGIC_LINK_INACTIVE_EMAIL_SUBJECT`                          | built-in, translated     | Subject of the inactive-account email.                                                                              |
| `MAGIC_LINK_TTL`                                             | `15m`                    | How long a link is valid (`ms` format or milliseconds).                                                             |
| `MAGIC_LINK_ALLOWED_PROVIDERS`                               | `default`                | Auth providers whose users can use magic links.                                                                     |
| `MAGIC_LINK_ALLOWED_ROLES` / `MAGIC_LINK_DISALLOWED_ROLES`   | —                        | Role IDs to allow or block.                                                                                         |
| `MAGIC_LINK_EMAIL_ALLOW_LIST` / `MAGIC_LINK_EMAIL_DENY_LIST` | —                        | Email patterns (see [Custom rules](#custom-rules)).                                                                 |
| `MAGIC_LINK_REQUIRE_TFA`                                     | `true`                   | Ask users with 2FA for their code.                                                                                  |
| `MAGIC_LINK_MAX_REQUESTS_PER_HOUR`                           | `5`                      | Emails per address per hour, inactive-account emails included. `0` turns the limit off.                             |
| `MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR`                    | `20`                     | Requests per IP per hour, answered with `429`. `0` turns the limit off.                                             |
| `MAGIC_LINK_MAX_OTP_ATTEMPTS`                                | `5`                      | Wrong 2FA codes before a link stops working. `0` turns the per-link limit off; `auth_login_attempts` still applies. |
| `MAGIC_LINK_STALL_TIME`                                      | `LOGIN_STALL_TIME` (500) | Minimum response time in ms, so timing doesn't reveal which accounts exist.                                         |
| `MAGIC_LINK_ENABLE_PAGES`                                    | `false`                  | Turn the [built-in pages](#built-in-pages-for-data-studio-users) on or off.                                         |
| `MAGIC_LINK_DEFAULT_REDIRECT`                                | `/admin`                 | Where the built-in pages go after sign-in.                                                                          |
| `MAGIC_LINK_TABLE`                                           | `extension_magic_link`   | Name of the token/audit table.                                                                                      |
| `MAGIC_LINK_RETENTION_DAYS`                                  | `30`                     | Audit rows older than this are deleted every hour.                                                                  |

## API reference

### `POST /magic-link/request`

```json
{ "email": "jane@example.com", "redirect_url": "https://example.com/auth/magic" }
```

The response is `204` whatever happens to the account. The other responses are:

- `400` if the email is malformed, if `redirect_url` isn't in `MAGIC_LINK_URL_ALLOW_LIST`, or if `redirect_url` is missing (it's optional only when the built-in pages are on);
- `429` (`REQUESTS_EXCEEDED`, with `Retry-After`) if the per-IP limit is reached.

With the [built-in pages](#built-in-pages-for-data-studio-users) on, a request without `redirect_url` links to them instead.

### `POST /magic-link/verify`

```json
{ "token": "…", "mode": "session", "otp": "123456" }
```

On success, the response is the same as `/auth/login`'s:

```json
{ "data": { "access_token": "…", "refresh_token": "…", "expires": 900000 } }
```

The error codes are listed in [What users are told](#what-users-are-told).

### Events

| Event                 | Type            | Use                                                                                                           |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `magic-link.validate` | filter          | Allow, refuse or skip the rules for a request or sign-in.                                                     |
| `magic-link.email`    | filter          | Change `subject`, `from`, `to` or `locale`, or add values to `templateData`. `kind` is `link` or `inactive`.  |
| `magic-link.login`    | filter / action | Filter: throw to refuse sign-in (`FORBIDDEN`). Action: `status` is `success` or `fail`.                       |
| `magic-link.request`  | action          | `status` is `sent`, `cancelled`, `failed` or `rejected`, with a `reason` and whether the user was `notified`. |

## Built-in pages for Data Studio users

If some of your users have access to the Data Studio, they can sign in to it with a magic link without a website. The extension ships script-free pages for this. They're off by default; turn them on with:

```bash
MAGIC_LINK_ENABLE_PAGES=true
PUBLIC_URL=https://admin.example.com
```

The pages need `PUBLIC_URL` to be Directus' full public address, because the links in the emails point to them. Without it, they answer `503` with an explanation, and Directus logs a warning at startup.

- `https://admin.example.com/magic-link` is the sign-in form. After signing in, users land on `/admin`.
- Add a link to it in _Settings → Project → Public Note_, which is shown on the Data Studio login screen. Directus doesn't let extensions add buttons to the login screen itself.
- `?redirect=/admin/content/articles` chooses where users land. The target must be a path on Directus or a URL in `MAGIC_LINK_URL_ALLOW_LIST`. Otherwise it's `MAGIC_LINK_DEFAULT_REDIRECT`.
- `?lang=fr-FR` forces a language. Otherwise the form follows the browser, and the confirmation page follows the user's Directus language.

Opening the link from the email shows a confirmation page, or the reason the link can't be used. The link is only used up when the user presses **Sign in**, so email scanners that open links can't burn it.

While the pages are on, a request without `redirect_url` links to them instead of your website.

## Going to production

- [ ] `PUBLIC_URL` is the public HTTPS address of Directus.
- [ ] `LOG_HTTP_IGNORE_PATHS=/magic-link/verify` is set, so sign-in links aren't written to the HTTP log (see [Limitations](#limitations)).
- [ ] `MAGIC_LINK_URL_ALLOW_LIST` lists only your real callback pages.
- [ ] The built-in pages are only on (`MAGIC_LINK_ENABLE_PAGES=true`) if Data Studio users need them.
- [ ] Behind a proxy, `IP_TRUST_PROXY` is set so the per-IP limit sees real client addresses.
- [ ] You've sent yourself a link, and it arrives and signs you in.

## Troubleshooting

Every request is recorded in the `extension_magic_link` table with a `status` and a `reason`, so look there first. It's an unmanaged table, and you can add it as a collection in the Data Studio if admins should be able to browse it.

| Symptom                                                   | Likely cause                                                                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No sign-in email, and the row says `rejected`             | See `reason`: `user_not_found`, `user_status_suspended` (the user got the inactive-account email instead), `email_not_allowed`, `role_not_allowed`, `rate_limited`, `provider_…_not_allowed` or `rejected_by_hook: …`. |
| No email, and the row says `failed`                       | Directus couldn't send it. `reason` holds the mail error. Check your `EMAIL_*` settings.                                                                                                                               |
| No email, and the row says `cancelled`                    | An `email.send` hook or Flow cancelled it.                                                                                                                                                                             |
| `400` "can't be used for magic links"                     | `redirect_url` isn't in `MAGIC_LINK_URL_ALLOW_LIST`. Scheme, host, port and path must match. The query string is ignored.                                                                                              |
| The browser shows a CORS error                            | `CORS_ENABLED` / `CORS_ORIGIN` don't include your website's origin.                                                                                                                                                    |
| Verify succeeds but the next request isn't signed in      | `credentials: 'include'` is missing, or Directus is on another site without `SameSite=None` and `Secure`.                                                                                                              |
| `400` "redirect_url is required"                          | The request had no `redirect_url`. It's only optional when the built-in pages are on.                                                                                                                                  |
| Emails link to Directus instead of your website           | The built-in pages are on and the request had no `redirect_url`.                                                                                                                                                       |
| The built-in pages answer "Cross-origin form submissions" | Directus was opened on an address other than `PUBLIC_URL`.                                                                                                                                                             |
| `503` "PUBLIC_URL must be the full public address"        | The built-in pages are on, but `PUBLIC_URL` is Directus' default `/` or not a full `https://…` address.                                                                                                                |
| `OTP_LIMIT_EXCEEDED`, or the account got suspended        | Too many wrong 2FA codes. The row says `locked`; the user requests a new link. A suspended account has to be reactivated by an admin.                                                                                  |

## Differences from `/auth/login`

- Core `auth.login` hooks **don't** run for magic-link sign-ins, because extensions can't send events on Directus' core emitter. Use `magic-link.login` instead. `auth.jwt` filters **do** run, with `type: "refresh"`.
- `auth_login_attempts` counts wrong 2FA codes, and suspends the account at the limit, like `/auth/login`. Directus doesn't let extensions use its own counter, so wrong passwords on `/auth/login` and wrong codes on magic links are counted separately.
- For users whose role requires 2FA but who haven't set it up yet, the token doesn't include the `enforce_tfa` flag. This is the same as a normal Directus token after its first refresh.

## Limitations

- **Links appear in Directus' HTTP log.** Directus logs request URLs and only redacts `access_token`. Links to your website don't reach Directus' log, but the built-in pages' `GET /magic-link/verify?token=…` does. The token is single-use and expires after `MAGIC_LINK_TTL`, but anyone who can read the log could use a link before its owner does. Set `LOG_HTTP_IGNORE_PATHS=/magic-link/verify` (supported on Directus 11 and 12) to keep these requests out of the log.
- **Bursts of requests may be refused entirely.** Every request is recorded before anything is counted, so simultaneous requests never get past the per-email or per-IP limit. The price is that requests arriving at exactly the same moment can all be refused, not just the ones over the limit.
- **Failed emails aren't retried.** They're marked `failed` and the user requests a new link.
- **The `user` column has no foreign key**, so the table works on every database Directus supports. If a user is deleted, their links stop working, and the rows are removed after `MAGIC_LINK_RETENTION_DAYS`.

## Development

```bash
pnpm typecheck
pnpm lint          # ESLint (typescript-eslint strict, type-aware)
pnpm format        # Prettier; use `pnpm format:check` in CI
pnpm test          # unit tests
pnpm test:e2e      # Docker: Directus 11 and 12 on SQLite, Postgres and MySQL, with Mailpit
pnpm test:e2e 12.4.0:postgres 11.0.0:sqlite   # specific targets
```

Dependencies are pinned to exact versions, and `.npmrc` sets `save-exact`, so `pnpm add` keeps pinning.

The e2e suite runs the real extension inside `directus/directus` images and sends real SMTP mail to Mailpit. By default it runs 58 scenarios, with the built-in pages on and a full `PUBLIC_URL`, against each of these targets:

- 11.0.0 on SQLite
- 11.9.3 on Postgres
- 11.17.4 on Postgres and on MySQL
- 12.0.0 on SQLite
- 12.4.0 on Postgres
- 12.5.0 on Postgres and on MySQL

Add a mode to a target to test another setup:

| Mode       | Setup                                                                 | Default targets                                                            |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `defaults` | A default Directus: pages off, `PUBLIC_URL` left at `/` (4 scenarios) | `12.5.0:sqlite:defaults`                                                   |
| `nourl`    | Pages on, `PUBLIC_URL` left at `/` (3 scenarios)                      | `12.5.0:sqlite:nourl`                                                      |
| `upgrade`  | Starts the published 1.0.0 first, then this build (the 58 scenarios)  | `11.0.0:sqlite:upgrade`, `12.5.0:postgres:upgrade`, `12.5.0:mysql:upgrade` |

### Releasing

New versions are published to npm by [.github/workflows/release.yml](.github/workflows/release.yml) through npm trusted publishing, so no npm token is stored anywhere.

One-time setup, run by a package owner (it asks for your npm 2FA):

```bash
npx npm@12.2.0 trust github directus-extension-magic-link --file release.yml --repository khanahmad4527/directus-extension-magic-link --allow-publish
```

npm expects the first publish through it within 2 days, so run it shortly before a release. If it expires, run it again.

To release:

1. Bump `version` in `package.json` and push to `main`.
2. Once CI passes, create a GitHub release whose tag is `v` plus that version, for example `v1.0.1`.

The workflow refuses to publish if the tag and `package.json` disagree, and runs the same checks as `pnpm publish` before uploading.

## License

[MIT](LICENSE)
