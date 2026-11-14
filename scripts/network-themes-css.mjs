// Writes src/app/network-themes.css from the reviewed theme sources (src/content/network-themes.ts).
import { writeFileSync } from "node:fs";
const { themeStylesheet, THEME_SOURCES } =
  await import("../src/content/network-themes.ts");
writeFileSync("src/app/network-themes.css", themeStylesheet());
console.log(JSON.stringify({ classes: THEME_SOURCES.length }));
