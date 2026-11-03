/**
 * Inline glyphs in `currentColor`: no icon font, no request, no filter to
 * lighten them on a dark surface. Decorative — the control carrying one
 * always has its own accessible name.
 */

interface GlyphProps {
  size?: number;
}

function Glyph({
  size = 16,
  children,
}: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Out of the tray: the share sheet. */
export function ShareGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </Glyph>
  );
}

export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Glyph>
  );
}

/** The navigation arrow: start the trip. */
export function NavigateGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3l7 18-7-4-7 4 7-18z" fill="currentColor" />
    </Glyph>
  );
}
