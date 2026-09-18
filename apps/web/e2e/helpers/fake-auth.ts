import type { Page } from "@playwright/test";

/**
 * Anonymous sign-in against the RTDB emulator, without Firebase Auth.
 *
 * The emulator accepts an **unsigned** JWT (`alg: "none"`) and reads `sub` as
 * `auth.uid` — the same trick `@firebase/rules-unit-testing` uses. So the only
 * thing that has to be faked is the identitytoolkit response; RTDB itself is
 * real, running `infra/database.rules.json` unmodified.
 *
 * The previous helper returned the literal string `"fake-id-token"`, which no
 * emulator would ever accept, and mocked RTDB over HTTP — a transport RTDB does
 * not use, since it dials a WebSocket that `page.route` cannot intercept. That
 * is why the suite it served could only ever assert "the page did not crash".
 *
 * Each browser context MUST get its own uid: two contexts sharing one uid claim
 * one slot, and the second participant never appears.
 */

const PROJECT_ID = "demo-meet-me-halfway";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned JWT the RTDB emulator accepts, carrying `uid` as `sub`. */
export function emulatorIdToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "none", typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    firebase: { identities: {}, sign_in_provider: "anonymous" },
  };
  // Trailing dot: the empty signature an `alg: none` token carries.
  return `${b64url(header)}.${b64url(payload)}.`;
}

/**
 * Serve anonymous sign-in and token refresh for one browser context.
 *
 * @param uid - distinct per context, or both participants land in one slot.
 */
export async function setupEmulatorAuth(page: Page, uid: string) {
  const idToken = emulatorIdToken(uid);

  await page.route("**/identitytoolkit.googleapis.com/**", (route) => {
    const url = route.request().url();

    // `accounts:lookup` — the SDK hydrates the user record after signUp.
    if (url.includes("accounts:lookup")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          users: [
            {
              localId: uid,
              lastLoginAt: String(Date.now()),
              createdAt: String(Date.now()),
              providerUserInfo: [],
            },
          ],
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "identitytoolkit#SignupNewUserResponse",
        localId: uid,
        idToken,
        refreshToken: `fake-refresh-${uid}`,
        expiresIn: "3600",
      }),
    });
  });

  await page.route("**/securetoken.googleapis.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: idToken,
        id_token: idToken,
        refresh_token: `fake-refresh-${uid}`,
        expires_in: "3600",
        token_type: "Bearer",
        user_id: uid,
        project_id: PROJECT_ID,
      }),
    }),
  );
}
