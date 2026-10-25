// Light, Dark and Black & white. The choice lives in the ps-theme cookie and is
// applied as data-theme on <html> before first paint (themeScript, run from the
// root layout), so there's no flash of the wrong theme.

export const THEMES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "mono", label: "Black & white" },
] as const;

export type Theme = (typeof THEMES)[number]["key"];

export const THEME_COOKIE = "ps-theme";

/** Fired on window whenever the theme changes, so every switcher stays in sync. */
export const THEME_EVENT = "ps-theme-change";

/** Sets data-theme on <html> from the cookie before first paint. */
export const themeScript = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);if(m)document.documentElement.setAttribute("data-theme",decodeURIComponent(m[1]))}catch(e){}})()`;

export function readThemeCookie(): Theme | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  const value = match ? decodeURIComponent(match[1]) : null;
  return THEMES.some((t) => t.key === value) ? (value as Theme) : null;
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.cookie = `${THEME_COOKIE}=${encodeURIComponent(theme)}; path=/; max-age=31536000; SameSite=Lax`;
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The theme on screen. */
export function currentTheme(): Theme {
  const shown = document.documentElement.getAttribute("data-theme");
  return readThemeCookie() ?? (THEMES.some((t) => t.key === shown) ? (shown as Theme) : "light");
}
