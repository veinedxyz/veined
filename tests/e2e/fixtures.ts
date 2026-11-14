// V1.9 shared E2E fixture: every page of every spec gets the deterministic Privy backend and WalletConnect relay
// doubles (tests/e2e/privy-mock.ts), so no test can reach a real Privy app, WalletConnect or wallet registry, and
// every third-party request is recorded. `connectWallet` drives the REAL Privy connect-only modal.
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { installPrimaryAssets, installPrimarySwap } from "./swap-primary";
import {
  mockPrivyBackend,
  mockWalletConnectRelay,
  type PrivyMock,
} from "./privy-mock";

export const test = base.extend<{
  privy: PrivyMock;
  relay: string[];
  defiIsolation: void;
  resourceDiagnostics: void;
}>({
  resourceDiagnostics: [
    async ({ context }, use, testInfo) => {
      const failures: { path: string; reason: string | null }[] = [];
      context.on("requestfailed", (request) => {
        const url = new URL(request.url());
        if (["127.0.0.1", "localhost"].includes(url.hostname))
          failures.push({
            path: url.pathname,
            reason: request.failure()?.errorText ?? null,
          });
      });
      await use();
      if (testInfo.status !== testInfo.expectedStatus)
        await testInfo.attach("local-request-failures", {
          body: JSON.stringify(failures, null, 2),
          contentType: "application/json",
        });
    },
    { auto: true },
  ],
  defiIsolation: [
    async ({ context }, use) => {
      await installPrimarySwap(context);
      await installPrimaryAssets(context);
      await context.route("**/api/portfolio/defi", (r) =>
        r.fulfill({ status: 503, json: { error: "SYNTHETIC_NOT_CHECKED" } }),
      );
      await use();
    },
    { auto: true },
  ],
  privy: [
    async ({ context }, use) => {
      await use(await mockPrivyBackend(context));
    },
    { auto: true },
  ],
  relay: [
    async ({ context }, use) => {
      await use(await mockWalletConnectRelay(context));
    },
    { auto: true },
  ],
});
export { expect };

/** The Privy modal (rendered by the SDK in a portal). */
export const privyModal = (page: Page) => page.locator("#privy-modal-content");

/**
 * Opens the Privy connect modal from `trigger` (default: the first "Connect wallet" button in the given locale)
 * and picks `walletName` there. Resolves when the modal has closed.
 */
export async function connectWallet(
  page: Page,
  walletName: string | RegExp,
  options: { label?: string; trigger?: ReturnType<Page["getByRole"]> } = {},
) {
  const trigger =
    options.trigger ??
    page
      .getByRole("button", {
        name: options.label ?? "Cüzdan bağla",
        exact: true,
      })
      .first();
  await trigger.click();
  const modal = privyModal(page);
  await expect(modal).toBeVisible({ timeout: 20000 });
  await modal.getByRole("button", { name: walletName }).first().click();
  await expect(modal).toBeHidden({ timeout: 20000 });
}

/**
 * V1.11 recipient UX: the recipient is the sender ("Same wallet") unless "Send to another address" is chosen; a
 * cross-ecosystem route shows the field directly. Fills #routing-recipient either way.
 */
export async function fillRecipient(page: Page, value: string) {
  const field = page.locator("#routing-recipient");
  if (!(await field.count()))
    await page.locator(".trade-parties .toggle input[type=checkbox]").check();
  await field.fill(value);
}

/**
 * Deep refinement (ux5): without a wallet, Swap keeps the address for read-only quotes behind one quiet line
 * ("Preview with a public address"). Opens that line when it is closed and returns the field, so every caller still
 * fills and asserts the same labelled input.
 */
export async function readOnlyAddress(
  scope: Page | Locator,
  label = "Wallet address for read-only quotes",
) {
  const closed = scope.locator(".swap-read-disclosure:not([open]) > summary");
  if (await closed.count()) await closed.first().click();
  return scope.getByLabel(label);
}
