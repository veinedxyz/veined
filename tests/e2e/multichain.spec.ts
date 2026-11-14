import type { Page } from "@playwright/test";
import { test, expect, connectWallet, fillRecipient } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote, normalizeStatus } from "../../src/routing/normalize";
import type { QuoteInput } from "../../src/routing/model";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
async function setup(
  page: Page,
  mode: "normal" | "no-route" | "stale" | "outage" | "branding" = "normal",
  delay = 0,
  theme: "dark" | "light" = "dark",
) {
  await page.addInitScript((appearance) => {
    // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "tr");
    localStorage.setItem("otherbridge.theme", appearance);
  }, theme);
  const catalog = fixtureCatalog();
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      status: 422,
      json: { error: "SYNTHETIC_CATALOG_UNAVAILABLE" },
    }),
  );
  if (mode === "branding")
    catalog.tools.push({
      id: "lifi-intents",
      name: "LI.FI Intents",
      kind: "bridge",
    });
  const requests: unknown[] = [];
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (mode === "outage") return json({ error: "PROVIDER_UNAVAILABLE" }, 422);
    if (body.action === "catalog")
      return json({ ...catalog, stale: mode === "stale" });
    if (body.action === "connections") {
      const f = catalog.networks.find((n) => n.id === body.source)!,
        t = catalog.networks.find((n) => n.id === body.destination)!;
      return json([
        {
          from: f.id,
          to: t.id,
          sourceAssets: [f.nativeAsset],
          destinationAssets: [t.nativeAsset],
          provider: "routing-core",
          executable: false,
        },
      ]);
    }
    if (body.action === "quote") {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (mode === "no-route")
        return json({ error: "NO_EXECUTABLE_ROUTE" }, 422);
      const input = body.input as QuoteInput;
      const raw = fixtureQuote(input);
      if (mode === "branding") {
        raw.tool = "lifi-intents";
        raw.toolDetails.name = "LI.FI Intents";
      }
      const q = normalizeQuote(raw, input, catalog);
      if (mode === "branding") {
        // Deliberately contaminated wire labels test the render boundary too.
        q.steps[0].toolName = "LI.FI DEX Aggregator";
        q.fees[0].name = "Routing infrastructure Fixed Fee";
      }
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return json([q]);
    }
    if (body.action === "status") {
      const ctx = body.context;
      return json(
        normalizeStatus(
          {
            status: "DONE",
            substatus: "COMPLETED",
            fromAddress: ctx.sourceAddress,
            toAddress: ctx.destinationAddress,
            sending: {
              txHash: body.hash,
              chainId: ctx.source,
              amount: ctx.amount,
              token: {
                ...catalog.networks.find((n) => n.id === ctx.source)!
                  .nativeAsset,
                address: ctx.sourceAsset,
              },
            },
            receiving: {
              txHash: `0x${"b".repeat(64)}`,
              chainId: ctx.destination,
              amount: ctx.minimum,
              token: {
                ...catalog.networks.find((n) => n.id === ctx.destination)!
                  .nativeAsset,
                address: ctx.destinationAsset,
              },
            },
          },
          body,
        ),
      );
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
  await page.goto("/bridge");
  await expect(
    page.getByRole("button", { name: "Kaynak ağ seç" }),
  ).toBeVisible();
  return { catalog, requests };
}
async function select(
  page: Page,
  role: "source" | "destination",
  search: string,
  id: string,
) {
  await page
    .getByRole("button", {
      name: role === "source" ? "Kaynak ağ seç" : "Hedef ağ seç",
    })
    .click();
  await page.locator("#network-search").fill(search);
  await page.locator(`.network-picker [data-chain="${id}"]`).click();
  await expect(page.locator("dialog.network-picker")).toHaveCount(0);
}
async function pair(page: Page, destination = "8453", search = "Base") {
  await select(page, "source", "Ethereum", "1");
  await select(page, "destination", search, destination);
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Veride mevcut" }),
  ).toBeHidden();
  await page.locator(".trade-settings-disclosure > summary").click();
  await expect(
    page.getByRole("status").filter({ hasText: "Veride mevcut" }),
  ).toBeVisible();
  await page.locator(".trade-settings-disclosure > summary").click();
}
async function fill(
  page: Page,
  recipient = "0x3333333333333333333333333333333333333333",
) {
  await page.locator("#routing-amount").fill("0.01");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await fillRecipient(page, recipient);
}
async function screenshot(page: Page, name: string) {
  await mkdir(`${base}/screenshots`, { recursive: true });
  if (name.startsWith("selector")) {
    await expect(page.locator("dialog.network-picker")).toBeVisible();
    if (!name.includes("outage"))
      await expect(page.locator(".picker-tools")).toContainText("72 ağ");
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll<HTMLImageElement>(".picker-option img"),
      ).every((i) => i.complete && i.naturalWidth > 0),
    );
  }
  await page.screenshot({
    path: `${base}/screenshots/${name}.png`,
    fullPage: (await page.locator("dialog[open]").count()) === 0,
  });
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
for (const lang of ["tr", "en"] as const) {
  test(`Public brand ${lang}: contaminated provider names never render in review or Activity`, async ({
    page,
  }) => {
    const { requests } = await setup(page, "branding");
    await pair(page);
    await fill(page);
    await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
    if (lang === "en") {
      await page.getByRole("button", { name: "Dil", exact: true }).click();
      await page
        .locator(".language-picker[open]")
        .getByRole("button", { name: "English", exact: true })
        .click();
    }
    await page
      .getByRole("button", {
        name: lang === "tr" ? "Rotayı incele" : "Review route",
        exact: true,
      })
      .click();
    await expect(page.locator(".routing-review")).toContainText(
      lang === "tr" ? "Rota hizmet ücreti" : "Route service fee",
    );
    await expect(page.locator(".routing-review")).toContainText(
      lang === "tr" ? "Değişim rotası" : "Exchange routing",
    );
    await expect(page.locator(".routing-review button.primary")).toBeDisabled();
    const denylist =
      /(?<![\p{L}\p{N}])li[ .-]?fi(?![\p{L}\p{N}])|jumper|routing\s+infrastructure|rota\s+altyap[ıi]s[ıi]|powered\s+by/iu;
    expect(await page.evaluate(() => document.body.textContent)).not.toMatch(
      denylist,
    );
    await screenshot(page, `public-brand-review-${lang}-synthetic`);
    await page
      .getByRole("button", {
        name:
          lang === "tr"
            ? "Activity için önizlemeyi kaydet"
            : "Save preview to Activity",
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: lang === "tr" ? "Önizleme kaydedildi" : "Preview saved",
      }),
    ).toBeVisible();
    await page
      .locator(".routing-review")
      .getByRole("button", { name: lang === "tr" ? "Kapat" : "Close" })
      .click();
    // Old previews may retain an upstream tool key missing from the new catalog.
    await page.route("**/api/routing", async (route) => {
      if (route.request().postDataJSON()?.action !== "catalog")
        return route.fallback();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(fixtureCatalog()),
      });
    });
    await page
      .getByRole("link", {
        name: lang === "tr" ? "İşlemler" : "Activity",
        exact: true,
      })
      .click();
    await page
      .locator(".preview-card > summary")
      .filter({ hasText: "Ethereum → Base" })
      .click();
    await expect(page.locator(".catalog-section ol")).toContainText(
      lang === "tr" ? "Niyet tabanlı rota" : "Intent routing",
    );
    await page
      .getByLabel(
        lang === "tr" ? "Kaynak işlem hash’i" : "Source transaction hash",
      )
      .fill(`0x${"a".repeat(64)}`);
    await page
      .getByRole("button", {
        name:
          lang === "tr"
            ? "Durumu salt okunur gözle"
            : "Observe status read-only",
      })
      .click();
    await expect(page.locator(".routing-observation")).toContainText(
      lang === "tr" ? "Rota durumu gözlemi" : "Route status observation",
    );
    expect(await page.evaluate(() => document.body.textContent)).not.toMatch(
      denylist,
    );
    await screenshot(page, `public-brand-activity-${lang}-synthetic`);
    expect(
      requests.every(
        (r) =>
          !["execute", "approve", "sign", "broadcast", "deploy"].includes(
            (r as { action: string }).action,
          ),
      ),
    ).toBe(true);
  });
}
test("M2 77 networks, virtual search, native logos and keyboard selection", async ({
  page,
}) => {
  const { requests } = await setup(page);
  await page.getByRole("button", { name: "Kaynak ağ seç" }).click();
  await expect(page.locator(".picker-tools")).toContainText("72 ağ");
  expect(await page.locator(".picker-option").count()).toBeLessThanOrEqual(10);
  await page.waitForFunction(() =>
    Array.from(
      document.querySelectorAll<HTMLImageElement>(".picker-option img"),
    ).every((i) => i.complete && i.naturalWidth > 0),
  );
  await screenshot(page, "selector-desktop-dark");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await page.locator("#network-search").fill("Sui");
  await expect(page.locator(".picker-option")).toHaveCount(1);
  await page.locator("#network-search").press("Enter");
  await expect(
    page.locator('.network-select-trigger[data-network="sui"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Kaynak ağ seç" }).click();
  await page.locator("#network-search").fill("no-such-network");
  await expect(
    page.getByRole("status").filter({ hasText: "Eşleşen ağ yok" }),
  ).toBeVisible();
  await page.locator("#network-search").fill("ONEchain");
  await page.locator("#network-search").press("Enter");
  await expect(
    page.locator('.network-select-trigger[data-network="onechain"]'),
  ).toBeVisible();
  expect(
    requests.every(
      (r: unknown) =>
        !["execute", "approve", "sign", "broadcast"].includes(
          (r as { action: string }).action,
        ),
    ),
  ).toBe(true);
});
for (const width of [360, 390, 768, 1440])
  for (const theme of ["dark", "light"] as const) {
    test(`M2/M7 ${width} ${theme} selector and ETH to Base route review`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await setup(page, "normal", 0, theme);
      await page.getByRole("button", { name: "Kaynak ağ seç" }).click();
      await screenshot(page, `selector-${width}-${theme}`);
      await page.locator("#network-search").fill("Ethereum");
      await page.locator('.network-picker [data-chain="1"]').click();
      await select(page, "destination", "Base", "8453");
      await fill(page);
      await expect(page.locator("#routing-sender")).toHaveValue(
        "0x3333333333333333333333333333333333333333",
      );
      await page
        .getByRole("button", { name: "Rotayı oku", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Rotayı incele", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("button", { name: "Rotayı incele", exact: true })
        .click();
      await expect(page.locator(".routing-review")).toBeVisible();
      await expect(
        page.locator(".routing-review button.primary"),
      ).toBeDisabled();
      await expect(page.locator(".routing-review")).toContainText(
        "Kesin sayı doğrulanmadı",
      );
      await expect(page.locator(".routing-review")).toContainText(
        "Rota hizmet ücreti",
      );
      await expect(page.locator(".routing-costs").last()).toContainText(
        "0,0000000000000001 ETH",
      );
      await noOverflow(page);
      await screenshot(page, `eth-base-review-${width}-${theme}`);
      const results = await new AxeBuilder({ page }).analyze();
      await mkdir(base, { recursive: true });
      await writeFile(
        `${base}/axe-routing-${width}-${theme}.json`,
        JSON.stringify(results, null, 2),
      );
      expect(results.violations).toEqual([]);
    });
  }
test("M3 amount/recipient/provider generation races cannot restore stale review", async ({
  page,
}) => {
  const { requests } = await setup(page, "normal", 650);
  await pair(page);
  await fill(page);
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await page.locator("#routing-amount").fill("0.02");
  await page.waitForTimeout(850);
  await expect(
    page.getByRole("button", { name: "Rotayı incele", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rotayı incele", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Rotayı incele", exact: true })
    .click();
  await page
    .locator(".routing-review")
    .getByRole("button", { name: "Kapat" })
    .click();
  await fillRecipient(page, "0x4444444444444444444444444444444444444444");
  await expect(
    page.getByRole("button", { name: "Rotayı incele", exact: true }),
  ).toHaveCount(0);
  expect(
    requests.filter(
      (r: unknown) => (r as { action: string }).action === "quote",
    ),
  ).toHaveLength(2);
});
test("M4 EVM to Solana uses a native recipient and fails closed on EVM address", async ({
  page,
}) => {
  await setup(page);
  await pair(page, "1151111081099710", "Solana");
  await fill(page);
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await expect(page.locator(".multichain-form [role=alert]")).toContainText(
    "Adres seçilen ağ",
  );
  await fillRecipient(page, "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Rotayı incele", exact: true }),
  ).toBeEnabled();
  await screenshot(page, "evm-solana-fixture-native-address");
  await select(page, "source", "Solana", "1151111081099710");
  await select(page, "destination", "Ethereum", "1");
  await expect(page.locator("#routing-sender")).toHaveValue("");
  await page
    .getByRole("button", { name: "Tarayıcı cüzdanından adres oku" })
    .click();
  await expect(page.locator(".multichain-form [role=alert]")).toContainText(
    "uyumlu tarayıcı cüzdanı",
  );
});
test("M3 no quote despite a connection has no fake route", async ({ page }) => {
  await setup(page, "no-route");
  await pair(page);
  await fill(page);
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await expect(page.locator(".multichain-form [role=alert]")).toContainText(
    "Yürütülebilir rota yok",
  );
  await expect(page.locator(".execution-status")).toContainText(
    "Gönderim kapalı",
  );
  await screenshot(page, "no-route-desktop");
});
test("M1 stale catalog is display-only; ONE custom composition stays non-executable after G5 verification", async ({
  page,
}) => {
  await setup(page, "stale");
  await select(page, "source", "Ethereum", "1");
  await select(page, "destination", "Base", "8453");
  await fill(page);
  await expect(
    page.getByRole("button", { name: "Rotayı oku", exact: true }),
  ).toBeDisabled();
  await screenshot(page, "stale-catalog");
  await select(page, "source", "ONEchain", "612055");
  await expect(
    // V1.6: G5 is verified read-only; sending still needs a separate approval (G7), so nothing executes.
    page
      .getByRole("status")
      .filter({ hasText: "G5 salt okunur olarak doğrulandı" })
      .filter({ hasText: "Bu birleşik rota yürütülemez" }),
  ).toBeVisible();
  await expect(page.locator(".execution-status")).toContainText(
    "Gönderim kapalı",
  );
  await screenshot(page, "onechain-custom-g5-verified-not-executable");
});
test("M2 outage, responsive zoom and reduced motion remain usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 768, height: 1000 });
  await setup(page, "outage");
  await page.getByRole("button", { name: "Kaynak ağ seç" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Rota verisi" }),
  ).toBeVisible();
  await page.addStyleTag({ content: "html { zoom: 2; }" });
  await noOverflow(page);
  await screenshot(page, "selector-outage-200-percent-css-zoom");
  await page.locator("#network-search").press("Escape");
  await expect(
    page.getByRole("button", { name: "Kaynak ağ seç" }),
  ).toBeFocused();
});
test("M5 quote preview persists in Activity with correct identities, never COMPLETED", async ({
  page,
}) => {
  await setup(page);
  await pair(page);
  await fill(page);
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await page
    .getByRole("button", { name: "Rotayı incele", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Activity için önizlemeyi kaydet" })
    .click();
  await expect(
    page.getByRole("button", { name: "Önizleme kaydedildi" }),
  ).toBeVisible();
  await page
    .locator(".routing-review")
    .getByRole("button", { name: "Kapat" })
    .click();
  await page.getByRole("link", { name: "İşlemler", exact: true }).click();
  await page
    .locator(".preview-card > summary")
    .filter({ hasText: "Ethereum → Base" })
    .click();
  await expect(page.locator(".catalog-section")).toContainText(
    "Yalnızca önizleme",
  );
  await expect(page.locator(".catalog-section")).not.toContainText("COMPLETED");
  await expect(page.locator(".catalog-section")).not.toContainText(
    "Teslimat doğrulandı",
  );
  await screenshot(page, "activity-routing-preview");
  await page.getByLabel("Kaynak işlem hash’i").fill(`0x${"a".repeat(64)}`);
  await page.getByRole("button", { name: "Durumu salt okunur gözle" }).click();
  await expect(page.locator(".routing-observation [role=status]")).toHaveText(
    "Teslimat doğrulandı",
  );
  await screenshot(page, "activity-synthetic-readonly-observation");
  await page.reload();
  await page
    .locator(".preview-card > summary")
    .filter({ hasText: "Ethereum → Base" })
    .click();
  await expect(page.locator(".routing-observation [role=status]")).toHaveText(
    "Güncel doğrulanmış gözlem yok",
  );
  await expect(page.locator(".catalog-section")).not.toContainText("COMPLETED");
  await expect(page.locator(".catalog-section")).not.toContainText(
    "Teslimat doğrulandı",
  );
});
test("M3 duplicate EVM identity events and wallet chain changes invalidate reviews", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
    if (window !== window.top) return;
    const listeners: Record<string, ((value: unknown) => void)[]> = {},
      methods: string[] = [];
    let chain = "0x1";
    let permitted = false;
    const provider = {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === "eth_requestAccounts") permitted = true;
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return permitted
            ? ["0x3333333333333333333333333333333333333333"]
            : [];
        if (method === "eth_chainId") return chain;
        throw Error("UNEXPECTED_WALLET_METHOD");
      },
      on: (event: string, fn: (value: unknown) => void) => {
        (listeners[event] ??= []).push(fn);
      },
      removeListener: (event: string, fn: (value: unknown) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      },
    };
    Object.assign(window, {
      routingWallet: {
        methods,
        emit: (event: string, value: unknown) => {
          if (event === "chainChanged") chain = String(value);
          listeners[event]?.forEach((fn) => fn(value));
        },
      },
    });
    window.addEventListener("eip6963:requestProvider", () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "routing-fixture",
              name: "Fixture MetaMask",
              rdns: "fake.wallet",
              icon: "",
            },
            provider,
          },
        }),
      ),
    );
  });
  await setup(page);
  await pair(page);
  await connectWallet(page, "Fixture MetaMask");
  // V1.11: the connected wallet is the sender (no raw source field); the recipient is the same wallet.
  await expect(page.locator(".trade-parties .party").first()).toContainText(
    "0x3333…3333",
  );
  await page.locator("#routing-amount").fill("0.01");
  for (const event of ["accountsChanged", "chainChanged"]) {
    await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Rotayı incele", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Rotayı incele", exact: true })
      .click();
    await expect(page.locator(".routing-review")).toBeVisible();
    await page.evaluate(
      (event) =>
        (
          window as unknown as {
            routingWallet: { emit: (event: string, value: unknown) => void };
          }
        ).routingWallet.emit(
          event,
          event === "accountsChanged"
            ? ["0x3333333333333333333333333333333333333333"]
            : "0x38",
        ),
      event,
    );
    await expect(page.locator(".routing-review")).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Rotayı incele", exact: true }),
    ).toHaveCount(0);
  }
  await expect(page.locator(".multichain-form")).toContainText(
    "cüzdanın ağı kaynak ağla eşleşmiyor",
  );
  const methods = await page.evaluate(
    () =>
      (window as unknown as { routingWallet: { methods: string[] } })
        .routingWallet.methods,
  );
  expect(
    methods.every((m) =>
      ["eth_requestAccounts", "eth_accounts", "eth_chainId"].includes(m),
    ),
  ).toBe(true);
});
