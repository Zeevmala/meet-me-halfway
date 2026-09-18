import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { setupEmulatorAuth } from "./fake-auth";
import { setupMapboxMocks } from "./mock-mapbox";

/** Selectors the live smoke test (`e2e-live/snapback.spec.ts`) already proves stable. */
export const CODE = ".live-badge-code";
export const PILLS = ".live-badge-pills .live-pill";
export const WAITING = ".live-waiting-title";
export const MIDPOINT = ".live-card .live-stats";
export const ERROR_TITLE = ".live-error-title";

export const TEL_AVIV = { latitude: 32.0853, longitude: 34.7818 };
export const HAIFA = { latitude: 32.794, longitude: 34.9896 };
export const JERUSALEM = { latitude: 31.7683, longitude: 35.2137 };
export const BEER_SHEVA = { latitude: 31.2518, longitude: 34.7913 };
export const EILAT = { latitude: 29.5577, longitude: 34.9519 };
export const NAZARETH = { latitude: 32.6996, longitude: 35.3035 };

export interface Participant {
  readonly ctx: BrowserContext;
  readonly page: Page;
}

/**
 * One browser context = one device.
 *
 * `uid` must be unique per participant: anonymous auth is what the slot claim
 * is keyed on, so two contexts sharing a uid claim one slot and the second
 * participant never appears. This is also why a human testing alone needs an
 * incognito window rather than a second tab.
 */
export async function participant(
  browser: Browser,
  uid: string,
  geolocation: { latitude: number; longitude: number },
): Promise<Participant> {
  const ctx = await browser.newContext({
    geolocation,
    permissions: ["geolocation"],
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await setupEmulatorAuth(page, uid);
  await setupMapboxMocks(page);
  return { ctx, page };
}

/** Boot a creator and return the 6-char code the database actually minted. */
export async function createSession(p: Participant): Promise<string> {
  await p.page.goto("/");
  const codeEl = p.page.locator(CODE);
  await expect(codeEl).toBeVisible({ timeout: 30_000 });
  const code = (await codeEl.textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

/** Unique per test file run, so parallel workers never collide on a uid. */
export function uid(label: string): string {
  return `e2e-${label}-${Math.random().toString(36).slice(2, 10)}`;
}
