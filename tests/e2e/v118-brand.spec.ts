import { test, expect } from "./fixtures";

for (const path of [
  "/",
  "/docs",
  "/portfolio",
  "/swap",
  "/bridge",
  "/activity",
  "/networks",
  "/help",
  "/settings",
]) {
  test(`V118 public identity ${path}`, async ({
    page,
    context,
    privy,
    relay,
  }) => {
    await context.addCookies([
      { name: "otherbridge.locale", value: "en", url: "http://127.0.0.1:3100" },
    ]);
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page).toHaveTitle(/VEINED/);
    await expect(page.locator("header a[href='/']")).toHaveAccessibleName(
      "VEINED",
    );
    const text = await page.locator("body").textContent();
    expect(text).not.toMatch(/Otherbridge|OTHERBRIDGE/);
    expect(
      await page
        .locator('a[href*="x.com/veinedxyz"],a[href^="mailto:"]')
        .count(),
    ).toBe(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
    expect(relay).toHaveLength(0);
    expect(
      privy.requests.filter((r) =>
        /\/wallets\//.test(typeof r === "string" ? r : JSON.stringify(r)),
      ),
    ).toHaveLength(0);
  });
}
test("V118 manifest and private indexing policy", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("VEINED");
  expect(manifest.short_name).toBe("VEINED");
  expect(await (await request.get("/robots.txt")).text()).toContain(
    "Disallow: /",
  );
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain(
    "<loc>",
  );
  expect((await request.get("/icon.svg")).ok()).toBe(true);
});
