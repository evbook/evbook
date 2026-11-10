# EVBook Token Helper — Chrome Web Store listing

Live at https://chromewebstore.google.com/detail/evbook-token-helper/bmlcajjacefiijccjjliojdaekghclld
(item ID `bmlcajjacefiijccjjliojdaekghclld`). To ship an update, bump `version`
in `extension/manifest.json`, build, and upload the new zip in the dashboard.

Everything the developer dashboard asks for, ready to paste. The package to
upload is `dist/client/evbook-token-helper.zip` (from `bun run build:app`).

## Store listing

**Name:** EVBook Token Helper (from the manifest)

**Summary** (manifest `description`, ≤132 chars):
Sign in to Tesla and get Owner API tokens for EVBook. Tokens go straight from Tesla to you — nothing is sent anywhere else.

**Category:** Tools

**Language:** English

**Description:**

> Get your Tesla Owner API access and refresh tokens in one sign-in — for EVBook or any logger that asks for them.
>
> How it works
> 1. Click the extension icon, then "Sign in with Tesla".
> 2. Sign in on Tesla's own page (auth.tesla.com). The extension never sees your password.
> 3. Copy the access and refresh tokens it shows you and paste them into EVBook.
>
> Private by design
> • No EVBook server is involved: the sign-in code is exchanged for tokens directly with Tesla, from your browser.
> • Tokens are shown once and wiped from the extension's storage straight away.
> • No analytics, no tracking, no accounts.
>
> Works for Tesla accounts worldwide, including China (auth.tesla.cn).
>
> EVBook Token Helper is not affiliated with or endorsed by Tesla, Inc.

**Images:** `screenshot-1-sign-in.png`, `screenshot-2-tokens.png` (1280×800),
`promo-small-440x280.png` (small promo tile). Icon comes from the package.

**Homepage URL:** https://evbook.app/token-helper/

## Privacy practices tab

**Single purpose:**
Sign the user in to their Tesla account and show them the resulting Owner API tokens so they can paste them into a vehicle logger.

**Permission justifications:**

- `host permission (auth.tesla.com, auth.tesla.cn)` — Opens Tesla's sign-in page and exchanges the one-time sign-in code for tokens at Tesla's token endpoint.
- `webRequest` — Tesla ends sign-in with a server redirect to `tesla://auth/callback` (the Tesla app's address). The extension observes redirects on auth.tesla.com only, to read the sign-in code from that one redirect.
- `webNavigation` — When the same redirect is made from page script rather than by the server it only shows up as a navigation event. The extension acts only on navigations to `tesla://auth/callback` that carry the `state` value of a sign-in it started itself, and ignores everything else.
- `storage` — Keeps the in-progress sign-in (PKCE verifier and state) and the result in `chrome.storage.session`, which is memory only, so the background worker can be restarted mid-sign-in. Cleared as soon as the tokens are shown.

**Remote code:** No, I am not using remote code.

**Data usage — collected data types:** tick **Authentication information** (the
sign-in code and tokens pass through the extension). Nothing else.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://evbook.app/token-helper/

## Distribution

Visibility: Public. Regions: all.
