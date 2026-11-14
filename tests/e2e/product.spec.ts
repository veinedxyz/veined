import type { Page } from "@playwright/test";
import {
  test,
  expect,
  connectWallet as connectThroughPrivy,
  privyModal,
} from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
const evidence = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1"}/screenshots`;
async function fixture(
  page: Page,
  options: {
    reject?: boolean;
    chain?: string;
    noWallet?: boolean;
    hangFirstChain?: boolean;
    delayFirstPermission?: boolean;
    permissionAccountEvent?: boolean;
    permissionConflict?: "account" | "chain" | "disconnect";
  } = {},
) {
  await page
    .context()
    .addCookies([
      { name: "otherbridge.locale", value: "tr", url: "http://127.0.0.1:3100" },
    ]);
  await page.addInitScript((opts) => {
    // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "tr");
    if (!localStorage.getItem("otherbridge.theme"))
      localStorage.setItem("otherbridge.theme", "dark");
    // V1.9: realistic extension semantics — no account before permission, eth_accounts follows account changes.
    let account = "0x3333333333333333333333333333333333333333";
    let permitted = false;
    const methods: string[] = [];
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    let resolvePermission: ((value: unknown) => void) | undefined;
    let chain = opts.chain ?? "0x7a69";
    let conflict = opts.permissionConflict;
    const provider = {
      request: async ({
        method,
        params,
      }: {
        method: string;
        params?: { chainId?: string }[];
      }) => {
        methods.push(method);
        if (
          [
            "eth_sendTransaction",
            "eth_sendRawTransaction",
            "eth_sign",
            "personal_sign",
            "eth_signTypedData_v4",
          ].includes(method)
        )
          throw Error("TEST_WRITE_REJECTED");
        if (method === "eth_requestAccounts") {
          if (opts.reject) throw { code: 4001, message: "User rejected" };
          permitted = true;
          if (opts.permissionAccountEvent)
            listeners.accountsChanged?.forEach((fn) => fn([account]));
          if (conflict === "account")
            listeners.accountsChanged?.forEach((fn) =>
              fn(["0x4444444444444444444444444444444444444444"]),
            );
          if (conflict === "chain")
            listeners.chainChanged?.forEach((fn) => fn("0x38"));
          if (conflict === "disconnect")
            listeners.disconnect?.forEach((fn) => fn({ code: 4900 }));
          conflict = undefined;
          return [account];
        }
        if (method === "eth_accounts") return permitted ? [account] : [];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = params?.[0]?.chainId ?? chain;
          listeners.chainChanged?.forEach((fn) => fn(chain));
          return null;
        }
        return null;
      },
      on: (event: string, fn: (v: unknown) => void) => {
        (listeners[event] ??= []).push(fn);
      },
      removeListener: (event: string, fn: (v: unknown) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      },
    };
    Object.assign(window, {
      testWallet: {
        methods,
        changeAccount: (address: string) => {
          account = address;
          listeners.accountsChanged?.forEach((fn) => fn([address]));
        },
        changeChain: (value: string) => {
          chain = value;
          listeners.chainChanged?.forEach((fn) => fn(value));
        },
        disconnect: () =>
          listeners.disconnect?.forEach((fn) => fn({ code: 4900 })),
        resolvePermission: () => resolvePermission?.([account]),
      },
    });
    if (!opts.noWallet)
      window.addEventListener("eip6963:requestProvider", () => {
        for (const [uuid, name] of [
          ["wallet-a", "Fixture Rabby"],
          ["wallet-b", "Fixture MetaMask"],
        ])
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: {
                info: {
                  uuid,
                  name,
                  rdns: "fake.wallet",
                  icon: 'data:image/svg+xml,<svg onload="window.pwned=true"/>',
                },
                provider: {
                  ...provider,
                  request: (args: {
                    method: string;
                    params?: { chainId?: string }[];
                  }) => {
                    if (
                      uuid === "wallet-a" &&
                      ((opts.hangFirstChain && args.method === "eth_chainId") ||
                        (opts.delayFirstPermission &&
                          args.method === "eth_requestAccounts"))
                    ) {
                      methods.push(args.method);
                      return new Promise((resolve) => {
                        if (args.method === "eth_requestAccounts")
                          resolvePermission = resolve;
                      });
                    }
                    return provider.request(args);
                  },
                },
              },
            }),
          );
      });
  }, options);
}
async function connectWallet(page: Page, name = "Fixture Rabby") {
  await connectThroughPrivy(page, name);
  await expect(
    page.getByText("100 ONE", { exact: false }).first(),
  ).toBeVisible();
}
test.beforeAll(async () => mkdir(evidence, { recursive: true }));
test("C1 normal permission accountsChanged grant connects in the real component", async ({
  page,
}) => {
  await fixture(page, { permissionAccountEvent: true });
  await page.goto("/bridge");
  await connectWallet(page);
  await expect(privyModal(page)).toBeHidden();
  await expect(page.locator("header .wallet-button")).toContainText(
    "0x3333…3333",
  );
  await page.screenshot({
    path: `${evidence}/permission-grant-connected.png`,
    fullPage: true,
  });
});
for (const conflict of ["account", "chain", "disconnect"] as const) {
  test(`C1 competing ${conflict} event during the Privy connection never binds an unconfirmed identity; another wallet recovers`, async ({
    page,
  }) => {
    await fixture(page, { permissionConflict: conflict });
    await page.goto("/bridge");
    await page
      .getByRole("button", { name: "Cüzdan bağla", exact: true })
      .first()
      .click();
    await privyModal(page)
      .getByRole("button", { name: "Fixture Rabby" })
      .click();
    // Whatever Privy reports, the session is only ever the account the wallet itself confirms (0x3333…).
    await page.waitForTimeout(1500);
    const header = page.locator("header .wallet-button");
    await expect(header).not.toContainText("0x4444");
    if (await privyModal(page).isVisible()) await page.keyboard.press("Escape");
    if (!(await header.innerText()).includes("0x3333")) {
      await connectWallet(page, "Fixture MetaMask");
    }
    await expect(header).toContainText("0x3333…3333");
    await expect(
      page.getByText("100 ONE", { exact: false }).first(),
    ).toBeVisible();
  });
}
for (const event of ["account", "chain", "disconnect"] as const) {
  test(`quote busy recovers after ${event} while old response is pending`, async ({
    page,
  }) => {
    await fixture(page);
    await page.goto("/bridge");
    await connectWallet(page);
    let release!: () => void, requested!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let first = true;
    await page.route("**/api/bridge", async (route) => {
      if (
        route.request().method() !== "POST" ||
        route.request().postDataJSON().action !== "quote" ||
        !first
      )
        return route.continue();
      first = false;
      const response = await route.fetch();
      requested();
      await hold;
      await route.fulfill({ response });
    });
    await page.getByLabel("Gönderilecek tutar", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Ücreti hesapla" }).click();
    await pending;
    await page.evaluate((event) => {
      const wallet = (
        window as unknown as {
          testWallet: {
            changeAccount: (v: string) => void;
            changeChain: (v: string) => void;
            disconnect: () => void;
          };
        }
      ).testWallet;
      if (event === "account")
        wallet.changeAccount("0x4444444444444444444444444444444444444444");
      if (event === "chain") wallet.changeChain("0x38");
      if (event === "disconnect") wallet.disconnect();
    }, event);
    if (event === "chain")
      await page
        .getByRole("button", { name: "Kaynak ağa geç", exact: true })
        .click();
    if (event === "disconnect") await connectWallet(page);
    const quoteButton = page.getByRole("button", { name: "Ücreti hesapla" });
    await expect(quoteButton).toBeEnabled();
    release();
    await expect(
      page.getByRole("button", { name: "Transferi incele" }),
    ).toHaveCount(0);
    await quoteButton.click();
    await page.getByRole("button", { name: "Transferi incele" }).click();
    await expect(
      page.getByRole("dialog").getByText("1 CROSS", { exact: false }).first(),
    ).toBeVisible();
    if (event === "account") {
      await page.screenshot({
        path: `${evidence}/quote-identity-recovered-desktop.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: `${evidence}/quote-identity-recovered-mobile.png`,
        fullPage: true,
      });
    }
    const methods = await page.evaluate(
      () =>
        (window as unknown as { testWallet: { methods: string[] } }).testWallet
          .methods,
    );
    expect(
      methods.filter((method) => /send|sign|permit/i.test(method)),
    ).toEqual([]);
  });
}

test("R1/C valid read-only quote and API enable flag cannot open wallet writes", async ({
  page,
}) => {
  await fixture(page, { chain: "0x956d7" });
  await page.route("**/api/bridge", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { mode: "mainnet-readonly", submission: true, version: "1" },
      });
      return;
    }
    const body = route.request().postDataJSON();
    if (body.action === "health")
      await route.fulfill({
        json: {
          mode: "mainnet-readonly",
          status: "blocked",
          observedAt: Date.now(),
          reasons: ["MAINNET_WRITE_DISABLED"],
        },
      });
    else if (body.action === "balance")
      await route.fulfill({
        json: {
          balance: "100000000000000000000",
          bnb: "0",
          sourceCode: "0x",
          destinationCode: "0x",
        },
      });
    else if (body.action === "quote")
      await route.fulfill({
        json: {
          id: "read-only-browser-gate-fixture",
          mode: "mainnet-readonly",
          account: body.account,
          recipient: body.account,
          route: "one-native-to-bsc-cross",
          config: "1",
          sourceChain: 612055,
          destinationChain: 56,
          token: "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510",
          amount: "12000000000000000000",
          networkFee: "180000000000000000",
          serviceFee: "0",
          gasBudget: "500000000000000",
          expected: "12000000000000000000",
          min: "5000000000000000000",
          max: "100000000000000000000",
          observedAt: Date.now(),
          expiresAt: Date.now() + 30000,
        },
      });
    else throw Error("UNEXPECTED_GATE_API_REQUEST");
  });
  await page.goto("/bridge");
  await connectWallet(page);
  await page.getByRole("textbox", { name: "Gönderilecek tutar" }).fill("12");
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await page.getByRole("button", { name: "Transferi incele" }).click();
  const review = page.getByRole("dialog");
  // V1.11: no persistent "read only" label; the execution state is the disabled CTA below.
  await expect(
    review.getByText("Ana ağ · salt okunur", { exact: true }),
  ).toHaveCount(0);
  await expect(
    review.getByRole("button", { name: "Gerçek gönderim kapalı", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: `${evidence}/mainnet-readonly-review-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}/mainnet-readonly-review-mobile.png`,
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const methods = await page.evaluate(
    () =>
      (window as unknown as { testWallet: { methods: string[] } }).testWallet
        .methods,
  );
  expect(methods.filter((method) => /send|sign|permit/i.test(method))).toEqual(
    [],
  );
});
test("R1/F4 a stalled wallet read never becomes the session; another wallet connects without writes", async ({
  page,
}) => {
  await fixture(page, { hangFirstChain: true });
  await page.goto("/bridge");
  await page
    .getByRole("button", { name: "Cüzdan bağla", exact: true })
    .first()
    .click();
  await privyModal(page).getByRole("button", { name: "Fixture Rabby" }).click();
  await page.waitForTimeout(3000);
  await expect(page.locator("header .wallet-button")).not.toContainText("0x");
  if (await privyModal(page).isVisible()) await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden();
  await connectWallet(page, "Fixture MetaMask");
  await expect(page.locator("header .wallet-button")).toContainText(
    "Fixture MetaMask",
  );
  const methods = await page.evaluate(
    () =>
      (window as unknown as { testWallet: { methods: string[] } }).testWallet
        .methods,
  );
  expect(methods.filter((method) => /send|sign/i.test(method))).toEqual([]);
  await page.screenshot({
    path: `${evidence}/wallet-timeout-recovered.png`,
    fullPage: true,
  });
});
test("R1/F4 closed pending permission cannot reconnect after its late result", async ({
  page,
}) => {
  await fixture(page, { delayFirstPermission: true });
  await page.goto("/bridge");
  await page
    .getByRole("button", { name: "Cüzdan bağla", exact: true })
    .first()
    .click();
  await privyModal(page).getByRole("button", { name: "Fixture Rabby" }).click();
  await expect(privyModal(page)).toContainText("Fixture Rabby");
  await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden();
  await page.evaluate(() =>
    (
      window as unknown as { testWallet: { resolvePermission: () => void } }
    ).testWallet.resolvePermission(),
  );
  await page.waitForTimeout(2000);
  // The late wallet answer after the user closed the modal never becomes the session.
  await expect(page.locator("header .wallet-button")).toHaveText(
    "Cüzdan bağla",
  );
  await connectWallet(page, "Fixture MetaMask");
});
test("R1/F5 delayed quote A cannot survive MAX amount B", async ({ page }) => {
  await fixture(page);
  await page.goto("/bridge");
  await connectWallet(page);
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/bridge", async (route) => {
    if (
      route.request().method() !== "POST" ||
      route.request().postDataJSON().action !== "quote" ||
      !first
    )
      return route.continue();
    first = false;
    const response = await route.fetch();
    requested();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByLabel("Gönderilecek tutar", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await pending;
  await page.getByRole("button", { name: "MAX", exact: true }).click();
  await expect(
    page.getByLabel("Gönderilecek tutar", { exact: true }),
  ).toHaveValue("99");
  release();
  await expect(
    page.getByRole("button", { name: "Ücreti hesapla" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Transferi incele" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await page.getByRole("button", { name: "Transferi incele" }).click();
  await expect(
    page.getByRole("dialog").getByText("99 CROSS", { exact: false }),
  ).toBeVisible();
});
test("W01/W05/X03 isolated EIP-6963 choice, icons inert, no wallet writes; local flow reloads and completes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  await page.goto("/bridge");
  await connectWallet(page);
  await page
    .getByLabel("Gönderilecek tutar", { exact: true })
    .fill("1.123456789123456789");
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await page.getByRole("button", { name: "Transferi incele" }).click();
  const dialog = page.getByRole("dialog", { name: "Transferi kontrol et" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('[data-network-logo="onechain"] img'),
  ).toBeVisible();
  await expect(dialog.locator('[data-network-logo="bsc"] img')).toBeVisible();
  await expect(
    dialog.getByText("0x3333333333333333333333333333333333333333", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/review-tr-dark.png`,
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Yerel senaryoyu çalıştır" })
    .click();
  await expect(page).toHaveURL(/\/activity\/[a-z0-9-]+/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "BSC’de sonraki adım" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/completed-tr-dark.png`,
    fullPage: true,
  });
  const methods = await page.evaluate(
    () =>
      (window as unknown as Window & { testWallet: { methods: string[] } })
        .testWallet.methods,
  );
  expect(methods).not.toContain("eth_sendTransaction");
  expect(
    await page.evaluate(() => (window as Window & { pwned?: boolean }).pwned),
  ).toBeUndefined();
  expect(errors).toEqual([]);
});
test("W02 no wallet and rejection are visible and recoverable", async ({
  page,
}) => {
  await fixture(page, { noWallet: true });
  await page.goto("/bridge");
  await page.getByRole("button", { name: "Cüzdan bağla" }).first().click();
  // No extension: the Privy modal offers no detected wallet and nothing connects.
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await expect(
    privyModal(page).getByRole("button", { name: /Fixture/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden();
  await expect(page.locator("header .wallet-button")).toHaveText(
    "Cüzdan bağla",
  );
  await fixture(page, { reject: true });
  await page.reload();
  await page.getByRole("button", { name: "Cüzdan bağla" }).first().click();
  await privyModal(page).getByRole("button", { name: "Fixture Rabby" }).click();
  // Rejection is shown by Privy with a retry; Otherbridge stays disconnected.
  await expect(
    privyModal(page).getByRole("button", { name: /Retry/ }),
  ).toBeVisible();
  await expect(page.locator("header .wallet-button")).toHaveText(
    "Cüzdan bağla",
  );
});
test("W03 wrong chain and account changes invalidate review, never submit", async ({
  page,
}) => {
  await fixture(page, { chain: "0x38" });
  await page.goto("/bridge");
  await connectWallet(page);
  await expect(page.getByText(/Cüzdan ağı farklı/)).toBeVisible();
  await page
    .getByRole("button", { name: "Kaynak ağa geç", exact: true })
    .click();
  await page.getByLabel("Gönderilecek tutar", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await page.getByRole("button", { name: "Transferi incele" }).click();
  await page.evaluate(() =>
    (
      window as unknown as Window & {
        testWallet: { changeAccount: (v: string) => void };
      }
    ).testWallet.changeAccount("0x4444444444444444444444444444444444444444"),
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Transferi incele" }),
  ).not.toBeVisible();
});
test("Q01/U04 network failure never becomes zero balance or successful quote", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/bridge");
  await connectWallet(page);
  await page.route("**/api/bridge", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON()?.action === "quote"
    )
      await route.fulfill({ status: 429, json: { error: "RATE_LIMITED" } });
    else await route.continue();
  });
  await page.getByLabel("Gönderilecek tutar", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Ücreti hesapla" }).click();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText(
    "İstek sınırına",
  );
  await expect(
    page.getByRole("button", { name: "Transferi incele" }),
  ).not.toBeVisible();
  await page.screenshot({
    path: `${evidence}/quote-error.png`,
    fullPage: true,
  });
});
test("P02/P03 poisoned history is preserved, imported completion is untrusted", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/activity");
  await page.evaluate(() =>
    localStorage.setItem("otherbridge.history.v1", '{"bad":true}'),
  );
  await page.reload();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText(
    "Yerel kayıt okunamadı",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("otherbridge.history.v1")),
  ).toBe('{"bad":true}');
});
test("P03 imported synthetic success stays unverified until actual evidence", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/activity");
  const address = "0x3333333333333333333333333333333333333333";
  const record = {
    schema: 1,
    id: "imported-one",
    mode: "local-test",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 31337,
    destinationChain: 31338,
    account: address,
    recipient: address,
    sourceAsset: "native:ONE",
    token: "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510",
    amount: "1000000000000000000",
    expected: "1000000000000000000",
    state: "COMPLETED",
    updatedAt: Date.now() - 10000,
  };
  // VWP G10: set the file only once React has hydrated this input (its props are attached); a change event fired
  // before hydration reaches no handler and the import is silently lost.
  await page.waitForFunction(() => {
    const input = document.querySelector('input[type="file"]');
    return (
      !!input && Object.keys(input).some((k) => k.startsWith("__reactProps$"))
    );
  });
  await page.getByLabel("Geçmişi içe aktar").setInputFiles({
    name: "history.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([record])),
  });
  await page.getByRole("link", { name: /1 ONE → CROSS/ }).click();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulanamadı" }),
  ).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(
    page.getByRole("heading", { name: "BSC’de sonraki adım" }),
  ).not.toBeVisible();
});
test("U01/U03/U04 actual responsive screenshots and overflow", async ({
  page,
}) => {
  await fixture(page, { noWallet: true });
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/bridge");
    await expect(
      page.getByText("Yerel test · sentetik veri").first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/bridge-${width}-tr-dark.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Dil", exact: true }).click();
  await page
    .locator(".language-picker[open]")
    .getByRole("button", { name: "English", exact: true })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect wallet" }).first(),
  ).toBeVisible();
  // The theme switch animates colors (0.16 s); measure contrast on the settled theme, not a mid-transition frame.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: `${evidence}/bridge-1440-en-light.png`,
    fullPage: true,
  });
});
test("U02 keyboard dialog focus, escape restoration, 200% CSS zoom and navigation", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/bridge");
  const trigger = page.getByRole("button", { name: "Cüzdan bağla" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.closest(
            "#privy-modal-content, [role=dialog], dialog",
          ) != null,
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.addStyleTag({ content: "html {zoom:2}" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${evidence}/bridge-zoom-200.png`,
    fullPage: true,
  });
  await page.addStyleTag({ content: "html {zoom:1}" });
  for (const path of [
    "/activity",
    "/networks",
    "/help",
    "/about",
    "/settings",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({
      path: `${evidence}/${path.slice(1)}-desktop.png`,
      fullPage: true,
    });
  }
});
