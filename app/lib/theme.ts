import { useSyncExternalStore } from "react";

/**
 * Light, dark, or whatever the OS is doing — the reader's choice from Settings.
 *
 * "system" is the default and the absence of a stored choice: the app follows the
 * OS, live, the way it always has. Picking light or dark pins it for this browser.
 * Kept in `localStorage` rather than the server's settings because it is a fact
 * about the device, not the logbook: the same instance is often read on a phone in
 * dark mode and a desk monitor in light.
 *
 * The scheme in force is written to `<html data-theme>`, which is what the
 * stylesheet's tokens and `dark:` variant key off. `index.html` does the first
 * write itself, before any of this has loaded, so the first paint is already right.
 */
export type ThemeChoice = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

/** Read by the inline script in index.html too — keep the two in step. */
const KEY = "evbook.theme";
const QUERY = "(prefers-color-scheme: dark)";

/** What the browser chrome is tinted to per scheme: the page background. */
const THEME_COLORS: Record<Scheme, string> = { light: "#f8f9fb", dark: "#0b0d12" };

/** The stored choice, read defensively: whatever is in the browser may be anything. */
export function themeFromStored(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** The scheme a choice comes to, given what the OS prefers. */
export function resolveScheme(choice: ThemeChoice, systemDark: boolean): Scheme {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

function readChoice(): ThemeChoice {
  try {
    return themeFromStored(localStorage.getItem(KEY));
  } catch {
    // Safari's private mode throws on storage access; follow the OS.
    return "system";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

const listeners = new Set<() => void>();
let current: ThemeChoice = typeof window === "undefined" ? "system" : readChoice();

function apply() {
  const scheme = resolveScheme(current, systemDark());
  document.documentElement.setAttribute("data-theme", scheme);
  /*
    The two theme-color metas in index.html carry media queries, so on their own
    they follow the OS. A pinned choice has to win over that, so both are pointed
    at the scheme in force; following the OS again puts their own values back.
  */
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    if (!meta.dataset.original) meta.dataset.original = meta.content;
    meta.content = current === "system" ? meta.dataset.original : THEME_COLORS[scheme];
  });
}

if (typeof window !== "undefined") {
  // The OS switching at sunset only matters while the reader is following it.
  window.matchMedia(QUERY).addEventListener("change", () => {
    if (current !== "system") return;
    apply();
    listeners.forEach((listener) => listener());
  });
  // Another tab picking a theme is this tab picking it too.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    current = themeFromStored(event.newValue);
    apply();
    listeners.forEach((listener) => listener());
  });
}

export function setThemeChoice(choice: ThemeChoice) {
  current = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Unstorable: the choice holds for this page and is gone on reload.
  }
  apply();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The reader's choice, and the scheme it comes to right now. */
export function useTheme(): { choice: ThemeChoice; scheme: Scheme } {
  const choice = useSyncExternalStore(subscribe, () => current);
  const scheme = useSyncExternalStore(subscribe, () => resolveScheme(current, systemDark()));
  return { choice, scheme };
}
