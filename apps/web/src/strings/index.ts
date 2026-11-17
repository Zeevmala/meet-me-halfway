/**
 * The app's copy, in one place.
 *
 * English only, by decision. The Hebrew locale went, and with it the language
 * detection, the stored choice, the right-to-left switching and i18next: a
 * framework for choosing between languages has nothing to choose from one.
 *
 * The table stays. Copy lives outside the components, and every key a
 * component names is checked against `en.json` at compile time, which
 * i18next's `t(string)` never did: a mistyped key rendered as itself.
 */
import en from "./en.json";

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every key in `en.json`, dotted: `"live.waitingTitle"`. */
export type StringKey = Leaves<typeof en>;

/** Values for a string's `{{name}}` placeholders. */
export type StringVars = Readonly<Record<string, string | number>>;

function flatten(
  node: object,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") out.set(prefix + key, value);
    else if (value !== null && typeof value === "object") {
      flatten(value as object, `${prefix}${key}.`, out);
    }
  }
  return out;
}

const TABLE: ReadonlyMap<string, string> = flatten(en, "", new Map());

/**
 * The string for `key`, with each `{{name}}` replaced from `vars`.
 *
 * A placeholder with no value is left as written, so a missing one shows on
 * screen as what it is rather than as "undefined".
 */
export function t(key: StringKey, vars?: StringVars): string {
  const template = TABLE.get(key) ?? key;
  if (vars === undefined) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = vars[name];
    return value === undefined ? placeholder : String(value);
  });
}
