import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { PROJECT_ID } from "./e2e-env";

/**
 * An ID token the Realtime Database emulator accepts.
 *
 * The emulator reads a token's claims without verifying its signature, so an
 * unsigned JWT is enough for `auth.uid` in the rules to be this user — the
 * same mechanism `@firebase/rules-unit-testing` uses. Real tokens would need
 * the Auth emulator as a second moving part for no extra coverage: sign-in is
 * not what this suite tests, the rules and the client are.
 */
function unsignedIdToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      auth_time: now,
      iat: now,
      exp: now + 3600,
      sub: uid,
      user_id: uid,
      firebase: { sign_in_provider: "anonymous", identities: {} },
    }),
    "",
  ].join(".");
}

/**
 * Answer Firebase Auth's anonymous sign-in for this page.
 *
 * Each call mints a fresh uid, so two pages in two browser contexts are two
 * distinct participants as far as the rules are concerned.
 *
 * Realtime Database traffic is deliberately not mocked: the e2e build points
 * it at the emulator (`.env.e2e`), loaded with the real rules by
 * `global-setup.ts`. The mock this replaces answered RTDB over HTTP with an
 * obsolete schema, which the WebSocket client never even asked for.
 *
 * @returns the uid this page signs in as.
 */
export async function setupFirebaseMocks(page: Page): Promise<string> {
  const uid = `e2e-${randomUUID()}`;
  const idToken = unsignedIdToken(uid);
  const createdAt = String(Date.now());

  await page.route("**/identitytoolkit.googleapis.com/**", (route) => {
    // signUp mints the anonymous user; lookup is the reload the SDK performs
    // straight after, and has a different response shape.
    if (route.request().url().includes("accounts:lookup")) {
      return route.fulfill({
        json: {
          users: [
            {
              localId: uid,
              providerUserInfo: [],
              lastLoginAt: createdAt,
              createdAt,
            },
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        localId: uid,
        idToken,
        refreshToken: "e2e-refresh-token",
        expiresIn: "3600",
      },
    });
  });

  await page.route("**/securetoken.googleapis.com/**", (route) =>
    route.fulfill({
      json: {
        id_token: idToken,
        refresh_token: "e2e-refresh-token",
        expires_in: "3600",
        token_type: "Bearer",
        user_id: uid,
        project_id: PROJECT_ID,
      },
    }),
  );

  return uid;
}
