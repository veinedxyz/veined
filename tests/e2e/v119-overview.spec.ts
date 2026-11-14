import { test, expect } from "./fixtures";

for (const width of [390, 1440]) {
  test(`V119 overview ${width}: launch, honest disconnected state and preserved destinations`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.addCookies([
      { name: "otherbridge.locale", value: "en", url: "http://127.0.0.1:3100" },
    ]);
    await page.goto("/");
    await page
      .locator(".mk-header")
      .getByRole("link", { name: "Launch App" })
      .click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.locator(".overview-wallet")).toContainText(
      "Nothing scanned yet",
    );
    await expect(page.locator(".overview-status")).toContainText(
      "sending is disabled",
    );
    await expect(page.locator(".overview-tools a")).toHaveCount(3);
    for (const path of ["portfolio", "bridge", "swap"])
      await expect(
        page.locator(`.overview-tools a[href='/${path}']`),
      ).toBeVisible();
    for (const path of ["networks", "activity", "docs"])
      await expect(
        page.locator(`.overview-explore a[href='/${path}']`),
      ).toBeVisible();
    // The landing illustration must never become an actual wallet value on the app home.
    await expect(page.locator(".overview")).not.toContainText("$12,480");
    await page.locator(".overview-tools a[href='/bridge']").click();
    await expect(page.locator(".bridge-card")).toBeVisible();
    await page.locator(".main-nav a[href='/app']").click();
    await expect(page.locator(".overview-wallet")).toContainText(
      "Nothing scanned yet",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
