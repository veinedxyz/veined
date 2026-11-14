import { test, expect } from "./fixtures";

test("V120 Portfolio meaningful first view is in the response and hydrates without errors", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "otherbridge.locale", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
    await scriptsReady;
    await route.continue();
  });
  const response = await page.goto("/portfolio", { waitUntil: "commit" });
  try {
    await expect(page.locator(".portfolio-first-scan")).toBeVisible();
    await expect(page.locator(".scan-field input").first()).toBeDisabled();
    await expect(page.locator(".scan-button")).toBeDisabled();
  } finally {
    releaseScripts();
  }
  const html = await response!.text();
  expect(html).toContain('class="card portfolio-first-scan"');
  expect(html).toContain("/assets/veined/ocean-film/portfolio-water-l960.webp");
  expect(html).toContain('loading="eager"');
  await expect(page.locator(".scan-field input").first()).toBeVisible();
  await expect(page.locator(".scan-field input").first()).toBeEnabled();
  await page.locator(".scan-field input").first().fill("not-an-address");
  await expect(page.locator(".scan-field input").first()).toHaveValue(
    "not-an-address",
  );
  expect(errors).toEqual([]);
});

test("V120 shared brand switches theme without layout shift or mirrored RTL geometry", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await context.addCookies([
    { name: "otherbridge.locale", value: "ar", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/settings");
  const link = page.locator("header a[href='/']");
  await expect(link).toHaveAccessibleName("VEINED");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  // Guardian finalization preview: the owner-approved octopus lockup (octopus tile + existing VEINED wordmark).
  const logo = link.locator("[data-brand-candidate='octopus-v1']");
  await expect(logo.locator(".veined-logo-dark")).toBeVisible();
  const before = await logo.boundingBox();
  await page.locator(".theme-toggle").click();
  await expect(logo.locator(".veined-logo-light")).toBeVisible();
  const after = await logo.boundingBox();
  expect(after).toEqual(before);
  expect(await logo.evaluate((el) => getComputedStyle(el).direction)).toBe(
    "ltr",
  );
  await link.focus();
  await expect(link).toBeFocused();
  await page.setViewportSize({ width: 360, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/");
  await expect(page.locator(".mk-brand")).toHaveAccessibleName("VEINED");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await page.locator(".mk-brand .veined-logo").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(148);
});

test("V120 metadata assets decode locally and maskable manifest is explicit", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /\/assets\/veined\/brand-octopus\/og-image\.png$/,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    /\/assets\/veined\/brand-octopus\/og-image\.png$/,
  );
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(
    manifest.icons.find((x: { purpose: string }) => x.purpose === "maskable"),
  ).toMatchObject({ sizes: "512x512", type: "image/png" });
  for (const icon of manifest.icons)
    expect((await request.get(icon.src)).ok()).toBe(true);
  expect((await request.get("/favicon.ico")).ok()).toBe(true);
  expect((await request.get("/apple-icon.png")).ok()).toBe(true);
  expect(await page.locator('a[href*="x.com/veinedxyz"]').count()).toBe(0);
});

test("V120 owner gallery preserves all three alternatives and approval remains open", async ({
  page,
}) => {
  await page.goto("/assets/veined/brand/review.html");
  await expect(page.locator("body")).toContainText("VEIN NEXUS");
  await expect(page.locator("body")).toContainText("MANTLE GRAPH");
  await expect(page.locator("body")).toContainText("QUIET CURRENT");
  expect(await page.locator('a[href*="x.com/veinedxyz"]').count()).toBe(0);
  expect(
    await page.evaluate(
      () =>
        [...document.images].filter((i) => i.complete && !i.naturalWidth)
          .length,
    ),
  ).toBe(0);
});
