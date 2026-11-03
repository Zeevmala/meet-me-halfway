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
 * coordinates put it, and that none of them is hidden under the top bar or the
 * sheet. The creator is a phone and the joiner a wide screen, so both layouts
 * are framed in one run.
 *
 * That is the gap that let three production defects through: the CSP blocked
 * Mapbox's stylesheet (markers rendered below the canvas, off-screen) and its
 * RTL text plugin, and the marker CSS offset every marker by the height of
 * the ones before it. None of them is visible to jsdom or to a page served
 * without the production headers. A fourth needed a phone-sized viewport:
 * padding sized for an older layout exceeded the map's height, Mapbox dropped
 * every fit, and participants sat half under the panel — with their centres
 * still inside the map, which is all this used to check.
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
  readonly context: BrowserContext;
  readonly page: Page;
  /** CSP violations, from the DOM event and from the browser's own report. */
  readonly cspViolations: string[];
}

interface DeviceOptions {
  /** The browser's language, which is what picks the app's. */
  readonly locale?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /**
   * Open with the flag the RTDB SDK leaves in localStorage when a WebSocket
   * closes before it was proven healthy — what iOS does to the sockets of a
   * page its user switched away from. With the flag set the SDK used to open
   * with JSONP long-polling, which the CSP refuses, so the device never
   * connected: a creator handed out a link to a session that was never
   * written, and a joiner sat on a bare map under "You are offline".
   */
  readonly webSocketFailedBefore?: boolean;
}

async function openDevice(
  browser: Browser,
  geolocation: { latitude: number; longitude: number },
  path: string,
  {
    locale = "en-US",
    viewport,
    webSocketFailedBefore = false,
  }: DeviceOptions = {},
): Promise<Device> {
  const context = await browser.newContext({
    geolocation,
    permissions: ["geolocation"],
    locale,
    ...(viewport === undefined ? {} : { viewport }),
  });
  openContexts.push(context);
  const page = await context.newPage();
  const cspViolations: string[] = [];

  if (webSocketFailedBefore) {
    await page.addInitScript(() => {
      localStorage.setItem("firebase:previous_websocket_failure", "true");
    });
  }

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
  return { context, page, cspViolations };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

interface MarkerLayout {
  readonly map: Box | null;
  /** What is drawn over the map: the top bar and the sheet. */
  readonly overlays: readonly Box[];
  readonly p0: Box | null;
  readonly p1: Box | null;
  readonly mid: Box | null;
}

/** Screen-space boxes of the two participant dots, the midpoint and the overlays. */
function markerLayout(page: Page): Promise<MarkerLayout> {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const at = (selector: string) => box(document.querySelector(selector));
    const overlays = [".live-topbar", ".live-sheet"]
      .map(at)
      .filter((b) => b !== null && b.width > 0 && b.height > 0);
    return {
      map: at(".live-map-container"),
      overlays: overlays as {
        x: number;
        y: number;
        width: number;
        height: number;
      }[],
      p0: at(".live-marker--p0"),
      p1: at(".live-marker--p1"),
      mid: at(".live-marker--mid"),
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
  if (layout.p0 === null || layout.p1 === null || layout.mid === null) {
    return Number.POSITIVE_INFINITY;
  }
  const p0 = centre(layout.p0);
  const p1 = centre(layout.p1);
  const mid = centre(layout.mid);
  return Math.hypot(mid.x - (p0.x + p1.x) / 2, mid.y - (p0.y + p1.y) / 2);
}

/**
 * The markers a user cannot fully see: not drawn, not wholly inside the map,
 * or partly under the top bar or the sheet. A centre inside the map is not
 * enough — the clipped markers of the phone layout all had one.
 */
function markersOutOfSight(layout: MarkerLayout): string[] {
  const { map, overlays } = layout;
  return (["p0", "p1", "mid"] as const).filter((key) => {
    const marker = layout[key];
    if (marker === null || map === null) return true;
    const inside =
      marker.x >= map.x &&
      marker.y >= map.y &&
      marker.x + marker.width <= map.x + map.width &&
      marker.y + marker.height <= map.y + map.height;
    return !inside || overlays.some((overlay) => overlaps(marker, overlay));
  });
}

/** The layouts the two devices are laid out in: a phone, and a wide screen. */
const PHONE = { width: 390, height: 844 } as const;

test("two devices meet, and the map draws them where they are", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  // Creator: anonymous sign-in, a session created under the real rules — by a
  // browser whose last WebSocket died young. Before RTDB was forced onto
  // WebSockets, this device's long-polling was refused by `script-src` and its
  // session never reached the database, so the joiner below read "Session not
  // found". The joiner stays clean, so both histories are covered.
  const creator = await openDevice(browser, TEL_AVIV, "/", {
    webSocketFailedBefore: true,
    viewport: PHONE,
  });
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
      .poll(async () => markersOutOfSight(await markerLayout(page)), {
        message: `${name}: every marker is in sight — inside the map, clear of the top bar and the sheet`,
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

// A link to a session the database never held. The rules deny that read rather
// than answer empty, and the same denial greets a device that may read nothing
// at all, so the join reads the `probe` rule before it blames the session.
// This device may read: what it is told is that the session does not exist.
test("a link to a session that was never created reads 'Session not found'", async ({
  browser,
}) => {
  const { page } = await openDevice(browser, TEL_AVIV, "/?code=MCK234");

  await expect(page.locator(".live-error-title")).toHaveText(
    /^Session not found/,
    { timeout: 30_000 },
  );
});

/**
 * The connectivity banner sits under the badge, clear of Mapbox's controls,
 * and says so in the browser's language.
 *
 * It used to run edge to edge on a phone, across the zoom and compass buttons,
 * and took their taps. Mapbox pins its controls to the physical top-right
 * whichever way the text runs, so logical insets put it over them in Hebrew
 * as well — and on a wide screen in Hebrew it was pinned to that corner.
 */
for (const { locale, offline } of [
  { locale: "en-US", offline: "You are offline" },
  { locale: "he-IL", offline: "אין חיבור לאינטרנט" },
] as const) {
  for (const viewport of [PHONE, { width: 1280, height: 800 }]) {
    test(`the offline banner leaves the map controls clear (${locale}, ${viewport.width}px)`, async ({
      browser,
    }) => {
      test.setTimeout(60_000);

      const { context, page } = await openDevice(browser, TEL_AVIV, "/", {
        locale,
        viewport,
      });
      await expect(page.locator(".live-badge-code")).toHaveText(
        /^[2-9A-HJKMNP-Z]{6}$/,
        { timeout: 30_000 },
      );
      const controls = page.locator(".mapboxgl-ctrl-top-right");
      await expect(controls).toBeVisible();

      await context.setOffline(true);
      const banner = page.locator(".live-offline-banner");
      await expect(banner).toContainText(offline);

      const bannerBox = await banner.boundingBox();
      const controlsBox = await controls.boundingBox();
      expect(bannerBox).not.toBeNull();
      expect(controlsBox).not.toBeNull();
      if (bannerBox !== null && controlsBox !== null) {
        expect(
          overlaps(bannerBox, controlsBox),
          `banner ${JSON.stringify(bannerBox)} overlaps the controls ${JSON.stringify(controlsBox)}`,
        ).toBe(false);
      }
    });
  }
}
