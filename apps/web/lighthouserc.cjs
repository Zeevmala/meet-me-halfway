/**
 * Lighthouse CI, as a phone sees the app: Lighthouse's default mobile
 * emulation (a mid-range phone, throttled network and CPU).
 *
 * It ran with the desktop preset, which measured a fast machine on a fast
 * connection, and so never saw the 5.7 s largest paint a phone got when the
 * page waited on the map before it would show anything. The PWA category it
 * asserted on was removed from Lighthouse, and every run warned that the
 * audit had not run.
 */
module.exports = {
  ci: {
    collect: {
      staticDistDir: "./dist",
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        "categories:performance": ["warn", { minScore: 0.8 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.9 }],
        "first-contentful-paint": ["warn", { maxNumericValue: 2000 }],
        "largest-contentful-paint": ["warn", { maxNumericValue: 3000 }],
        "total-blocking-time": ["warn", { maxNumericValue: 300 }],
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
