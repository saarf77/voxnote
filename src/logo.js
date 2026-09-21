/**
 * The mark: a ramble settling into a line — a wave that calms down into flat,
 * readable text, on WhatsApp green. LOGO_SVG is the one-wave cut that stays
 * legible at nav and favicon sizes; docs/logo.svg is the full four-wave mark.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Logo">
<rect width="64" height="64" rx="18" fill="#25d366"/>
<path d="M8 32q5.5-26 11 0q5.5 22 11 0h26" fill="none" stroke="#121212" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const LOGO_DATA_URI = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
