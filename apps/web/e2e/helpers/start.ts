import type { Page } from "@playwright/test";

/** The start screen's button: "Start a session", or "Join" on a session link. */
export const START_BUTTON = ".live-start-btn";

/**
 * Agree on the start screen, which stands before every session.
 *
 * Nothing is signed in to, asked for or written until this tap, so a spec
 * that wants a session has to make it, as a person does.
 */
export async function start(page: Page): Promise<void> {
  await page.locator(START_BUTTON).click();
}
