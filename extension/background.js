// Tesla's `ownerapi` client only accepts the mobile app's redirect,
// `tesla://auth/callback`, which no web page can receive. So we start the
// sign-in ourselves (PKCE, in a tab we opened), catch the redirect on its way
// out of auth.tesla.com, and exchange the code for tokens right here. Nothing
// but Tesla ever sees the code or the tokens.

const CLIENT_ID = "ownerapi";
const REDIRECT_URI = "tesla://auth/callback";
const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const DEFAULT_ISSUER = "https://auth.tesla.com/oauth2/v3";
// China accounts are bounced to their own issuer, which says so in the callback.
const ISSUERS = new Set([DEFAULT_ISSUER, "https://auth.tesla.cn/oauth2/v3"]);

function base64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomString(n) {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function start() {
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const tab = await chrome.tabs.create({ url: url.toString() });
  // Session storage survives the service worker being stopped mid-sign-in.
  await chrome.storage.session.set({ pending: { tabId: tab.id, state, verifier } });
}

async function exchange(issuer, code, verifier) {
  try {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token && body.refresh_token) {
      return { access: body.access_token, refresh: body.refresh_token };
    }
    return { error: body.error_description || body.error || `Tesla answered ${res.status}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

let handling = false;

async function handleCallback(tabId, url) {
  if (typeof url !== "string" || !url.startsWith(REDIRECT_URI) || handling) return;
  // Several listeners see the same redirect; only the first one gets past here.
  handling = true;
  try {
    const { pending } = await chrome.storage.session.get("pending");
    const params = new URLSearchParams(url.split("?")[1] || "");
    const code = params.get("code");
    if (!pending || params.get("state") !== pending.state || !code) return;
    await chrome.storage.session.remove("pending");

    // Move the tab off the dead tesla:// navigation straight away; the page
    // fills in when Tesla answers.
    await chrome.storage.session.set({ result: { busy: true } });
    await chrome.tabs.update(tabId >= 0 ? tabId : pending.tabId, { url: chrome.runtime.getURL("tokens.html") });

    const issuer = ISSUERS.has(params.get("issuer")) ? params.get("issuer") : DEFAULT_ISSUER;
    await chrome.storage.session.set({ result: await exchange(issuer, code, pending.verifier) });
  } finally {
    handling = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "start") start();
});

// The server answers the sign-in with a 302 to tesla://auth/callback.
chrome.webRequest.onBeforeRedirect.addListener((d) => handleCallback(d.tabId, d.redirectUrl), {
  urls: ["https://auth.tesla.com/*", "https://auth.tesla.cn/*"],
});

// A navigation from script (location.href = "tesla://…") shows up here instead.
const onNav = (d) => d.frameId === 0 && handleCallback(d.tabId, d.url);
chrome.webNavigation.onBeforeNavigate.addListener(onNav);
chrome.webNavigation.onErrorOccurred.addListener(onNav);
