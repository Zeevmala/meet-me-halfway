import type { Page } from "@playwright/test";

const FAKE_UID = "test-user-abc123";

/** Intercept Firebase Auth + RTDB HTTP requests with canned responses */
export async function setupFirebaseMocks(page: Page) {
  // Mock Firebase Auth — signInAnonymously hits identitytoolkit
  await page.route("**/identitytoolkit.googleapis.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        localId: FAKE_UID,
        idToken: "fake-id-token",
        refreshToken: "fake-refresh-token",
        expiresIn: "3600",
      }),
    }),
  );

  // Mock Firebase Auth token refresh
  await page.route("**/securetoken.googleapis.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id_token: "fake-id-token",
        refresh_token: "fake-refresh-token",
        expires_in: "3600",
        token_type: "Bearer",
        user_id: FAKE_UID,
      }),
    }),
  );

  // Mock RTDB REST requests (long-polling fallback)
  await page.route("**/*.firebaseio.com/**", (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === "PUT" || method === "PATCH") {
      // Writes — echo back
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    }

    // Reads — return session-like data
    if (url.includes("/sessions/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          created: Date.now(),
          creatorUid: FAKE_UID,
          participantUids: { [FAKE_UID]: true },
          participants: {
            [FAKE_UID]: {
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: Date.now(),
            },
          },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });

  // Mock reCAPTCHA / App Check
  await page.route("**/recaptchaenterprise.googleapis.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokenProperties: { valid: true } }),
    }),
  );
}
