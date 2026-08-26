import { useId } from 'react';

/**
 * YOZZ — drawn, not typeset.
 *
 * The brand asked for weight and for MOTION, and the name already contains the device: Z is the
 * alphabet's only mostly-diagonal letter, and this name has two of them. Set in caps the diagonals
 * dominate (lowercase pulls a `y` descender down and shrinks the `z`), so the wordmark is four
 * letters where a still O sits between a diagonal Y and a pair of Zs, on a 10° forward oblique.
 *
 * Two devices carry the character, and both are the system's own — a rule, used twice:
 *
 * 1. **The whole word closes up to a hairline.** The letters sit on a 4-unit gap rather than a
 *    letter space, so YOZZ reads as one block divided by rules, the way the list is one surface
 *    divided by rules. It stops at 4 rather than 0: fused letters turn to a blob at the 14px the
 *    rail renders, and the hairline is the thing this system separates with anyway.
 * 2. **A hairline cuts straight through.** The same rule turned on the mark itself — a 7-unit band
 *    knocked out at mid-height. Checked at every size it ships at; it holds at 14px, and it is what
 *    stops the word being merely slick. `public/favicon.svg` carries the same line, but inverted —
 *    there the letter is the hole, so the band is signal restored across it — and on a letter drawn
 *    heavier, because at 16px the wordmark's own proportions leave the line no room.
 *
 * It is GEOMETRY, not a font. The system's radius is 0 and no shipped face obeys that in an O — so
 * this one is a square ring, which is also what a terminal block glyph looks like, and every letter
 * here is a rectangle or a parallelogram. It needs no second font file for four characters, and it
 * scales to the favicon without a rasteriser.
 *
 * Geist and Geist Mono stay exactly as they are: they are a metrically matched pair carrying
 * columns of mono values beside sans prose, and a display face has no business in that.
 */

/** One Z. Reused twice, which is the point of the name. */
const Z = 'M0 0H76V26L36 74H76V100H0V74L40 26H0Z';

export const Wordmark = ({ className }: { className?: string }) => {
  // The mask needs a document-unique id: the rail and the reader-at-rest both render a wordmark,
  // and they are on screen together.
  const cut = useId();

  return (
    <svg
      viewBox="0 0 334 100"
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      // The brand is always caps, including here. Worth knowing: some screen readers treat a short
      // all-caps string as an initialism and spell it "Y-O-Z-Z" — if that ever grates, the fix is
      // lowercase in this attribute only, since it changes nothing on screen.
      aria-label="YOZZ"
    >
      {/* White keeps, black cuts — mask luminance, not theme colour, so these two stay literal. */}
      <mask id={cut}>
        <rect width="334" height="100" fill="#fff" />
        <rect y="46.5" width="334" height="7" fill="#000" />
      </mask>
      {/* The oblique is applied once to the whole word so the letters stay on one slant, and the
          translate puts the bottom-left corner back inside the box after the skew pulls it left. */}
      <g mask={`url(#${cut})`} transform="translate(17.63 0) skewX(-10)">
        {/* Letters advance 80: their own 76 plus the 4-unit hairline. */}
        <path d="M0 0H26L38 30L50 0H76L51 58V100H25V58Z" />
        <path transform="translate(80 0)" d="M0 0H76V100H0ZM26 26H50V74H26Z" />
        <path transform="translate(160 0)" d={Z} />
        <path transform="translate(240 0)" d={Z} />
      </g>
    </svg>
  );
};
