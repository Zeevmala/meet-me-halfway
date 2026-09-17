/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
  ],
  // CI lints the whole package now, not just src/, so the generated and
  // vendored trees have to be named here rather than implied by the glob.
  ignorePatterns: [
    "dist",
    "node_modules",
    "coverage",
    "playwright-report",
    "test-results",
    ".eslintrc.cjs",
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "react-hooks", "jsx-a11y"],
  overrides: [
    {
      // Build, lint and test tooling runs in Node, not the browser. Scoped
      // rather than global: application code under src/ must not see `module`
      // or `process` as defined — this is a zero-backend PWA.
      files: ["*.cjs", "*.js", "*.config.ts", "rules/**/*.ts"],
      env: { node: true },
    },
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    // RTL safety: warn on hardcoded physical margin/padding directional properties.
    // Prefer CSS logical properties (margin-inline-start, padding-inline-end, etc.)
    "no-restricted-syntax": [
      "warn",
      {
        // Catches inline style objects: style={{ marginLeft: ..., paddingRight: ... }}
        selector:
          "JSXAttribute[name.name='style'] Property[key.name=/^(marginLeft|marginRight|paddingLeft|paddingRight)$/]",
        message:
          "Avoid physical margin/padding directional props in inline styles — use logical equivalents " +
          "(marginInlineStart, marginInlineEnd, paddingInlineStart, paddingInlineEnd) for RTL safety.",
      },
    ],
  },
};
