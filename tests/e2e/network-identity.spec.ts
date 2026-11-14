import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { CROSS, type TransferRecord } from "../../src/core/model";
import { READ_ONLY_DEPLOYMENT } from "../../src/adapters/deployment";

const evidence =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
const account = "0x3333333333333333333333333333333333333333";

// Axe marks gradient backgrounds incomplete. Bound every text color against
// the full configured light intensity, rather than relying on a single pixel.
async function gradientContrast(page: Page) {
  return page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    function rgb(value: string) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    }
    function luminance(color: number[]) {
      const linear = color.map((v) => {
        const channel = v / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    function contrast(a: number[], b: number[]) {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }
    const results = [];
    for (const card of document.querySelectorAll<HTMLElement>(
      ".network-tinted",
    )) {
      const style = getComputedStyle(card);
      const base = rgb(style.backgroundColor);
      const glow = style
        .getPropertyValue("--network-glow")
        .trim()
        .split(/\s+/)
        .map(Number);
      const alpha = Number(style.getPropertyValue("--network-card-light"));
      for (const element of card.querySelectorAll<HTMLElement>("*")) {
        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        if (!text || element.closest('[aria-hidden="true"]')) continue;
        const foreground = rgb(getComputedStyle(element).color);
        const ratios = Array.from({ length: 21 }, (_, step) => {
          const a = (alpha * step) / 20;
          return contrast(
            foreground,
            base.map((v, i) => v * (1 - a) + glow[i] * a),
          );
        });
        results.push({
          network: card.dataset.network,
          text,
          foreground,
          base,
          glow,
          alpha,
          minimumRatio: Math.min(...ratios),
        });
      }
    }
    return results;
  });
}

async function readOnlyFixture(page: Page, theme: "dark" | "light") {
  const record: TransferRecord = {
    schema: 1,
    id: "network-identity-readonly-fixture",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account,
    recipient: account,
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "12000000000000000000",
    expected: "12000000000000000000",
    state: "SUBMISSION_UNKNOWN",
    error: "MANUAL_ACTION_REQUIRED",
    updatedAt: Date.now(),
  };
  await page.addInitScript(
    ({ record, theme }) => {
      // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", "tr");
      localStorage.setItem("otherbridge.theme", theme);
      localStorage.setItem("otherbridge.history.v1", JSON.stringify([record]));
      Object.assign(window, {
        identityWalletMethods: [] as string[],
        ethereum: {
          request: ({ method }: { method: string }) => {
            (
              window as unknown as { identityWalletMethods: string[] }
            ).identityWalletMethods.push(method);
            throw Error("NO_WALLET_ACCESS_IN_VISUAL_TEST");
          },
        },
      });
    },
    { record, theme },
  );
  await page.route("**/api/bridge", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { mode: "mainnet-readonly", submission: false },
      });
    const body = route.request().postDataJSON();
    if (body.action === "health")
      return route.fulfill({
        json: {
          mode: "mainnet-readonly",
          status: "blocked",
          observedAt: Date.now(),
          reasons: ["MAINNET_WRITE_DISABLED"],
          source: {
            chainId: 612055,
            block: "45450558",
            timestamp: "1790925085",
          },
          destination: {
            chainId: 56,
            block: "125250183",
            timestamp: "1790925085",
          },
        },
      });
    if (body.action === "track")
      return route.fulfill({
        json: {
          kind: "chain",
          observedAt: Date.now(),
          record: body.record,
          evidence: {
            policy: {
              sourceContract: READ_ONLY_DEPLOYMENT.source,
              destinationContract: READ_ONLY_DEPLOYMENT.destination,
              sourceConfirmations: 1,
              destinationConfirmations: 1,
              finality: "node-finalized",
            },
          },
        },
      });
    throw Error(`UNEXPECTED_VISUAL_API_ACTION:${body.action}`);
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [360, 768, 1440]) {
    test(`network identity ${theme} ${width}: bridge, networks, activity and detail`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(60000);
      await mkdir(`${evidence}/screenshots`, { recursive: true });
      await readOnlyFixture(page, theme);
      await page.setViewportSize({ width, height: 1100 });
      const errors: string[] = [];
      const externalImages: string[] = [];
      const checks = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          request.resourceType() === "image" &&
          new URL(request.url()).origin !== baseURL
        )
          externalImages.push(request.url());
      });
      try {
        for (const [name, path] of [
          ["bridge", "/bridge"],
          ["networks", "/networks"],
          ["activity", "/activity"],
          ["detail", "/activity/network-identity-readonly-fixture"],
        ]) {
          await page.goto(path);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          await expect(page.locator("h1")).toBeVisible();
          const main = page.locator("main");
          for (const id of ["onechain", "bsc"]) {
            const logo = main
              .locator(`[data-network-logo="${id}"] img`)
              .first();
            await expect(logo).toBeVisible();
            await expect(logo).toHaveAttribute("src", `/networks/${id}.svg`);
            await expect
              .poll(() =>
                logo.evaluate(
                  (image: HTMLImageElement) =>
                    image.complete && image.naturalWidth > 0,
                ),
              )
              .toBe(true);
            const box = await logo.boundingBox();
            expect(box!.width).toBeGreaterThanOrEqual(15);
          }
          await expect(main.locator(".coin")).toHaveCount(0);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          expect(overflow).toBe(false);
          if (name === "bridge") {
            const source = main.locator(".network-box[data-network=onechain]");
            const destination = main.locator(".network-box[data-network=bsc]");
            await expect(source).toHaveAttribute("aria-label", "Kaynak ağ seç");
            await expect(source).toContainText("Gönderen");
            await expect(source).toContainText("612055");
            await expect(destination).toHaveAttribute(
              "aria-label",
              "Hedef ağ seç",
            );
            await expect(destination).toContainText("Hedef");
            await expect(destination).toContainText("56");
            await expect(destination).toContainText("CROSS");
            await expect(main.locator(".under-button")).toHaveText(
              "Gerçek gönderim kapalı",
            );
            await expect(
              main.getByRole("button", {
                name: "Yerel senaryoyu çalıştır",
                exact: true,
              }),
            ).toHaveCount(0);
          }
          if (name === "networks") {
            await expect(
              main.locator(".network-card[data-network=onechain]"),
            ).toContainText("612055");
            await expect(
              main.locator(".network-card[data-network=bsc]"),
            ).toContainText("56");
          }
          if (name === "detail") {
            await expect(
              main.locator(".timeline [data-network=onechain]"),
            ).toContainText("ONEchain");
            await expect(
              main.locator(".timeline [data-network=bsc]"),
            ).toContainText("BSC");
            await expect(
              main.getByRole("heading", {
                name: "Teslimat doğrulandı",
                exact: true,
              }),
            ).toHaveCount(0);
          }
          const a11y = await new AxeBuilder({ page }).analyze();
          const gradients = await gradientContrast(page);
          checks.push({
            path,
            theme,
            width,
            overflow,
            violations: a11y.violations,
            incomplete: a11y.incomplete,
            gradientContrast: gradients,
          });
          await page.screenshot({
            path: `${evidence}/screenshots/identity-${name}-${width}-${theme}.png`,
            fullPage: true,
          });
          expect(a11y.violations).toEqual([]);
          expect(gradients.every((check) => check.minimumRatio >= 4.5)).toBe(
            true,
          );
        }
        expect(errors).toEqual([]);
        expect(externalImages).toEqual([]);
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { identityWalletMethods: string[] })
                .identityWalletMethods,
          ),
        ).toEqual([]);
      } finally {
        await writeFile(
          `${evidence}/identity-checks-${width}-${theme}.json`,
          JSON.stringify(
            {
              fixture:
                "Mock read-only health / hashless claim; no live transaction",
              checks,
              errors,
              externalImages,
            },
            null,
            2,
          ),
        );
      }
    });
  }
}
