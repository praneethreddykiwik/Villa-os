export type ThemeChoice = "light" | "dark" | "system";

/** The cookie the server reads in the root layout to stamp <html data-theme>. */
export const THEME_COOKIE = "glentree-theme";

/**
 * Apply a theme choice to the live document and remember it.
 *
 * "system" is a real third state, not a default: it removes the attribute
 * entirely so the prefers-color-scheme query in globals.css decides, and keeps
 * following the OS afterwards — which a two-way toggle cannot do.
 *
 * A cookie rather than localStorage, because the server renders the correct
 * theme into the first response from it. localStorage is only readable after
 * hydration, which is exactly late enough to show a flash of the wrong one.
 */
export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

/** Narrow an untrusted cookie value to a choice, defaulting to "system". */
export function readThemeChoice(raw: string | undefined): ThemeChoice {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}
