# Sign in and connect a Tesla account

**Category** Access
**Persona** Owner of a fresh self-hosted install
**Spec** [`sign-in.spec.ts`](sign-in.spec.ts)

## Why it matters

This is the only door into the app. It runs against a second worker with
`DEV_AUTOLOGIN` switched off, so it exercises the real password check and the
real Tesla token validation rather than the local shortcut.

## Preconditions

- `APP_PASSWORD` is set, and the Tesla account is not connected yet.
- The mock Tesla API accepts any non-empty token pair.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the app | The password screen asks for the app password |
| 2 | Submit a wrong password | "Wrong password." appears, no session is issued |
| 3 | Submit the right password | The Tesla connect screen appears |
| 4 | Paste the token pair and submit | The overview loads with the car on it |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
