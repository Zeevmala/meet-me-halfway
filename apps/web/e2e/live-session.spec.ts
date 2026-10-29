import { test, expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { setupFirebaseMocks } from "./helpers/mock-firebase";
import { setupMapboxMocks } from "./helpers/mock-mapbox";

/**
 * Two devices, the real client, the real security rules, and the headers
 * production serves.
 *
 * Every other spec here asserts that `.live-page` rendered, which the error
 * boundary's fallback also satisfies. This one walks the core flow — create,
 * share, join, meet — against the RTDB emulator, under the CSP read straight
 * from firebase.json (see `productionHeaders` in vite.config.ts), and then
 * checks what a user actually looks at: that each marker is drawn where its
 * coordinates put it.
 *
 * That is the gap that let three production defects through: the CSP blocked
 * Mapbox's stylesheet (markers rendered below the canvas, off-screen) and its
 * RTL text plugin, and the marker CSS offset every marker by the height of
 * the ones before it. None of them is visible to jsdom or to a page served
 * without the production headers.
 *
 * Right-to-left labels are not asserted here. Since mapbox-gl 3.33 they need
 * no plugin; Mapbox fetches its shaping module only once RTL text is on
 * screen, and the mocked style draws no text at all.
 */

const TEL_AVIV = { latitude: 32.0853, longitude: 34.7818 };
const HAIFA = { latitude: 32.794, longitude: 34.9896 };

/** Mercator and great-circle curvature over ~80 km stay well under this. */
const MARKER_TOLERANCE_PX = 3;

/** Contexts made from the worker-scoped `browser` outlive a test unless closed. */
const openContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((context) => context.close()));
});

interface Device {
  readonly page: Page;
  /** CSP violations, from the DOM event and from the browser's own report. */
  readonly cspViolations: string[];
}

async function openDevice(
  browser: Browser,
  geolocation: { latitude: number; longitude: number },
  path: string,
): Promise<Device> {
  const context = await browser.newContext({
    geolocation,
    permissions: ["geolocation"],
    locale: "en-US",
  });
  openContexts.push(context);
  const page = await context.newPage();
  const cspViolations: string[] = [];

  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `[csp] ${event.violatedDirective} ${event.blockedURI || "inline"}`,
      );
    });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[csp]") || text.includes("Content Security Policy")) {
      cspViolations.push(text);
    }
  });

  await setupFirebaseMocks(page);
  await setupMapboxMocks(page);
  await page.goto(path);
  return { page, cspViolations };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface MarkerLayout {
  readonly map: { left: number; top: number; right: number; bottom: number };
  readonly p0: Point | null;
  readonly p1: Point | null;
  readonly mid: Point | null;
}

/** Screen-space centres of the two participant dots and the midpoint dot. */
function markerLayout(page: Page): Promise<MarkerLayout> {
  return page.evaluate(() => {
    const centre = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const map = document
      .querySelector(".live-map-container")
      ?.getBoundingClientRect();
    return {
      map: {
        left: map?.left ?? 0,
        top: map?.top ?? 0,
        right: map?.right ?? 0,
        bottom: map?.bottom ?? 0,
      },
      p0: centre(".live-marker--p0"),
      p1: centre(".live-marker--p1"),
      mid: centre(".live-marker--mid"),
    };
  });
}

/**
 * How far the midpoint dot sits from halfway between the two participant
 * dots, in pixels.
 *
 * Over ~80 km the geographic midpoint projects to the screen midpoint to
 * within a pixel, so any marker drawn away from its coordinates shows up
 * here — without the test reaching into the map instance for `project()`.
 */
function midpointOffsetPx(layout: MarkerLayout): number {
  const { p0, p1, mid } = layout;
  if (p0 === null || p1 === null || mid === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(mid.x - (p0.x + p1.x) / 2, mid.y - (p0.y + p1.y) / 2);
}

/** The markers that are not inside the visible map. */
function markersOffMap(layout: MarkerLayout): string[] {
  const { map } = layout;
  return (["p0", "p1", "mid"] as const).filter((key) => {
    const point = layout[key];
    return (
      point === null ||
      point.x < map.left ||
      point.x > map.right ||
      point.y < map.top ||
      point.y > map.bottom
    );
  });
}

test("two devices meet, and the map draws them where they are", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  // Creator: anonymous sign-in, a session created under the real rules.
  const creator = await openDevice(browser, TEL_AVIV, "/");
  const codeBadge = creator.page.locator(".live-badge-code");
  await expect(codeBadge).toHaveText(/^[2-9A-HJKMNP-Z]{6}$/, {
    timeout: 30_000,
  });
  const code = (await codeBadge.textContent()) ?? "";

  // Joiner: claims a slot through the write-once rule, from 80 km away.
  const joiner = await openDevice(browser, HAIFA, `/?code=${code}`);

  // Both see each other: the midpoint card replaces the waiting card only
  // once each has the other's presence write.
  for (const { page } of [creator, joiner]) {
    await expect(page.locator(".live-nav-buttons")).toBeVisible({
      timeout: 45_000,
    });
  }

  // Soft from here: when the map is wrong it is usually wrong in more than
  // one way at once, and a run should name every way rather than the first.
  const check = expect.configure({ soft: true });

  for (const [name, device] of [
    ["creator", creator],
    ["joiner", joiner],
  ] as const) {
    const { page } = device;

    await check
      .poll(
        () =>
          page.evaluate(() => {
            const canvas = document.querySelector(".mapboxgl-canvas");
            return canvas === null ? null : getComputedStyle(canvas).position;
          }),
        { message: `${name}: Mapbox's stylesheet is applied` },
      )
      .toBe("absolute");

    await check
      .poll(async () => markersOffMap(await markerLayout(page)), {
        message: `${name}: every marker is inside the visible map`,
        timeout: 15_000,
      })
      .toEqual([]);

    await check
      .poll(async () => midpointOffsetPx(await markerLayout(page)), {
        message: `${name}: the midpoint marker sits halfway between the participants`,
        timeout: 15_000,
      })
      .toBeLessThan(MARKER_TOLERANCE_PX);

    check(device.cspViolations, `${name}: no CSP violations`).toEqual([]);
  }
});
