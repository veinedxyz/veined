/**
 * VEINED V1.20 — original editable vector construction, 2026-10-25.
 * All logo lettering and marks are editable path geometry. No font, stock icon,
 * image trace, generative raster, network fetch or third-party logo is involved.
 * Coordinates are a 128-unit icon grid and a 240 × 40 wordmark grid.
 */
export const palette = Object.freeze({
  graphite: "#0b0c0f",
  surface: "#151619",
  sage: "#bdccb9",
  sageDeep: "#3e604a",
  ivory: "#f1f0ec",
  paper: "#f6f4f0",
  ink: "#232326",
  muted: "#b0afb5",
  warm: "#e3bd77",
});

export const concepts = [
  {
    id: "a-vein-nexus",
    letter: "A",
    name: "VEIN NEXUS",
    rationale:
      "Eight routes converge on a quiet, open nucleus. Curved branches connect organic vein structure with precise network coordination.",
    construction:
      "Eight open cubic route paths; one closed four-lobed nucleus with an open central counter. Branches are intentionally free of terminal dots.",
    paths: [
      { d: "M64 48C64 35 58 29 58 15", stroke: true },
      { d: "M76 52C85 43 87 31 99 23", stroke: true },
      { d: "M81 64C94 64 99 58 113 58", stroke: true },
      { d: "M76 76C85 85 98 85 106 97", stroke: true },
      { d: "M64 81C64 94 70 99 70 113", stroke: true },
      { d: "M52 76C43 85 41 98 29 106", stroke: true },
      { d: "M47 64C34 64 29 70 15 70", stroke: true },
      { d: "M52 52C43 43 30 41 22 29", stroke: true },
      {
        d: "M64 42C69 42 72 49 77 51C82 53 87 59 87 64C87 69 80 72 78 77C76 82 69 87 64 87C59 87 56 80 51 78C46 76 41 69 41 64C41 59 48 56 50 51C52 46 59 42 64 42ZM64 55C59 55 55 59 55 64C55 69 59 73 64 73C69 73 73 69 73 64C73 59 69 55 64 55Z",
        fillRule: "evenodd",
      },
    ],
    scores: [8, 10, 8, 7, 8, 8, 8, 9, 8, 8],
  },
  {
    id: "b-mantle-graph",
    letter: "B",
    name: "MANTLE GRAPH",
    rationale:
      "A calm mantle is cut by seven rising channels, leaving eight implied extensions. A solid, architectural silhouette, without eyes or illustrated tentacles.",
    construction:
      "One pointed mantle silhouette with a flared lower edge; seven rising negative-space channels imply exactly eight extensions. The pointed upper contour avoids a cartoon head.",
    paths: [
      {
        d: "M64 10C85 26 107 44 112 65L118 108H110L97 66Q94 62 91 65Q89 67 91 71L104 108H96L86 63Q84 59 80 61Q77 63 79 67L90 108H82L76 61Q75 56 71 57Q67 58 69 64L76 108H68V58C68 52 60 52 60 58V108H52L59 64Q61 58 57 57Q53 56 52 61L46 108H38L49 67Q51 63 48 61Q44 59 42 63L32 108H24L37 71Q39 67 37 65Q34 62 31 66L18 108H10L16 65C21 44 43 26 64 10Z",
      },
    ],
    scores: [8, 9, 9, 6, 9, 7, 9, 9, 8, 9],
  },
  {
    id: "c-quiet-current",
    letter: "C",
    name: "QUIET CURRENT",
    rationale:
      "Two inbound currents merge into one continuous V. An open incision at the shoulder makes the junction visible; a rounded bend releases into a rising, tapered route.",
    construction:
      "One closed cubic silhouette with an open shoulder incision; no strokes, masks, overlap or filters. Two inbound branches join below the incision; the rising terminal balances the broad lower bend.",
    paths: [
      {
        d: "M14 24C19 24 23 25 27 26L48 69C50 74 53 78 58 80L39 32C45 37 50 44 54 52L64 73C67 79 71 79 74 73L94 32C100 20 108 15 118 15L85 90C81 101 74 108 64 108C54 108 47 101 42 90L26 56C22 47 19 43 14 40Z",
      },
    ],
    scores: [9, 9, 10, 9, 10, 10, 10, 10, 9, 9],
  },
];

export const recommended = concepts[2];
export const rubric = [
  "Distinctiveness",
  "Brand-story relevance",
  "Professional appearance",
  "Small-size clarity",
  "Monochrome quality",
  "Scalability",
  "Wordmark compatibility",
  "Dark/light contrast",
  "Icon recognizability",
  "Web3 suitability without generic crypto imagery",
];

// Original cap lettering. The broad V and softened D echo the icon's contrast
// between direct routes and curved transitions. Coordinates deliberately preserve
// a full-height I rather than a tiny stem that could disappear at nav size.
export const wordmarkPaths = [
  { letter: "V", d: "M0 4H7L18 31L29 4H36L21 38H15Z" },
  { letter: "E", d: "M47 4H74L71 10H54V18H69V24H54V32H74V38H47Z" },
  { letter: "I", d: "M87 4H94V38H87Z" },
  { letter: "N", d: "M108 38V4H115L135 27V4H142V38H135L115 15V38Z" },
  { letter: "E", d: "M156 4H183L180 10H163V18H178V24H163V32H183V38H156Z" },
  {
    letter: "D",
    d: "M196 4H211C224 4 232 10 232 21C232 32 224 38 211 38H196ZM203 10V32H211C220 32 225 28 225 21C225 14 220 10 211 10Z",
    fillRule: "evenodd",
  },
];

export function markGeometry(concept, color) {
  return `<g fill="${color}">${concept.paths.map((p) => `<path d="${p.d}"${p.stroke ? ` fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"` : ""}${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}/>`).join("")}</g>`;
}

export function wordGeometry(color) {
  return `<g fill="${color}">${wordmarkPaths.map((p) => `<path d="${p.d}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ""}/>`).join("")}</g>`;
}

export function svgDocument(width, height, body, title = "VEINED") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title>${body}</svg>\n`;
}

export function iconSvg(concept, color, background) {
  return svgDocument(
    128,
    128,
    `${background ? `<rect width="128" height="128" rx="26" fill="${background}"/>` : ""}${markGeometry(concept, color)}`,
    `VEINED — ${concept.name} — owner-review candidate`,
  );
}

export function wordmarkSvg(color) {
  return svgDocument(
    232,
    42,
    wordGeometry(color),
    "VEINED — custom vector wordmark",
  );
}

export function lockupSvg(concept, iconColor, typeColor, background) {
  return svgDocument(
    376,
    96,
    `${background ? `<rect width="376" height="96" rx="14" fill="${background}"/>` : ""}<g transform="translate(8 8) scale(.625)">${markGeometry(concept, iconColor)}</g><g transform="translate(112 25) scale(1.04)">${wordGeometry(typeColor)}</g>`,
    `VEINED — ${concept.name} — owner-review candidate`,
  );
}
