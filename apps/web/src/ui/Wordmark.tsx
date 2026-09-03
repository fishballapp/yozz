import { useId } from 'react';

/** Drawn, not typeset: rectangles and parallelograms on a 10° oblique, a 4-unit gap and a hairline knocked out at mid-height. See DESIGN.md. */

/** One Z, reused twice. */
const Z = 'M0 0H76V26L36 74H76V100H0V74L40 26H0Z';

export const Wordmark = ({ className }: { className?: string }) => {
  // A document-unique mask id: the rail and the reader-at-rest are on screen together.
  const cut = useId();

  return (
    <svg
      viewBox="0 0 334 100"
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      // Some screen readers spell a short all-caps string as an initialism; lowercase here if that grates.
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
