/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist", ".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
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
