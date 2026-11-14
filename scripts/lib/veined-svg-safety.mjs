import { SaxesParser } from "saxes";

const allowedElements = new Set([
  "svg",
  "title",
  "desc",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "text",
]);
const allowedAttributes = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "role",
  "aria-labelledby",
  "id",
  "fill",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "opacity",
  "transform",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "clip-path",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "text-anchor",
]);

/** Fail closed; only our inert, self-contained drawing subset is exportable. */
export function assertSafeSvg(source) {
  if (typeof source !== "string" || source.length > 500_000)
    throw new Error("SVG source size/type rejected");
  const parser = new SaxesParser({ xmlns: false });
  const ids = new Set();
  const localReferences = [];
  let root = null;
  let elements = 0;
  parser.on("doctype", () => {
    throw new Error("SVG doctype rejected");
  });
  parser.on("processinginstruction", () => {
    throw new Error("SVG processing instruction rejected");
  });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (node) => {
    if (!allowedElements.has(node.name))
      throw new Error(`SVG element rejected: ${node.name}`);
    if (!root) root = node;
    elements += 1;
    for (const [key, value] of Object.entries(node.attributes)) {
      if (!allowedAttributes.has(key))
        throw new Error(`SVG attribute rejected: ${key}`);
      if (key === "xmlns" && value !== "http://www.w3.org/2000/svg")
        throw new Error("SVG namespace rejected");
      if (/[<>]|javascript:|data:|https?:\/\//i.test(value) && key !== "xmlns")
        throw new Error(`SVG external/executable value rejected: ${key}`);
      if (/url\s*\(/i.test(value)) {
        const match = /^url\(#([A-Za-z][\w-]*)\)$/.exec(value);
        if (!match) throw new Error("SVG nonlocal URL rejected");
        localReferences.push(match[1]);
      }
      if (key === "id") {
        if (ids.has(value)) throw new Error("SVG duplicate id rejected");
        ids.add(value);
      }
    }
  });
  parser.write(source).close();
  if (
    !root ||
    root.name !== "svg" ||
    root.attributes.xmlns !== "http://www.w3.org/2000/svg"
  )
    throw new Error("SVG root rejected");
  for (const reference of localReferences)
    if (!ids.has(reference)) throw new Error("SVG missing local reference");
  const dimensions = [root.attributes.width, root.attributes.height].map(
    Number,
  );
  if (dimensions.some((n) => !Number.isFinite(n) || n <= 0 || n > 8192))
    throw new Error("SVG dimensions rejected");
  return {
    sanitized: true,
    width: dimensions[0],
    height: dimensions[1],
    elements,
    externalResources: 0,
  };
}
