// SYNTHETIC_TEST_ONLY: actual broker/durable projection with browser HTTP interception; never opens a production gate.
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ManualBroker } from "../../src/manual-wallet/server/broker";
import { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import { ScanIndex } from "../../src/scan/server";
import { manualTx } from "../../src/manual-wallet/protocol";
import { setup } from "../visual-restoration/helpers";
test("synthetic E2E: wallet result appears automatically, polling updates, restart retains one record", async ({
  page,
}) => {
  const dir = mkdtempSync(resolve("../evidence/ingestion-e2e-")),
    account = "0x" + "7".repeat(40),
    hash = "0x" + "8".repeat(64);
  const ledger = CanaryDurableStore.open(join(dir, "wallet", account));
  ledger.append("ACCOUNT_BIND", { account, firstNonce: "0" });
  let index = new ScanIndex(join(dir, "index"));
  await setup(page, { realApi: true });
  await page.route("**/api/scan", async (route) => {
    const b = route.request().postDataJSON();
    index.ingest(join(dir, "wallet"));
    await route.fulfill({
      json: {
        records: index.list(
          b.q || undefined,
          b.chain === "all" ? undefined : b.chain,
        ),
        errors: [],
        asOf: Date.now(),
      },
    });
  });
  try {
    await page.goto(`/scan?q=${account}`);
    await expect(page.locator(".sc-record")).toHaveCount(0);
    const tx = manualTx({
      chainId: "0x2105",
      from: account,
      to: "0x" + "9".repeat(40),
      value: "0x0",
      data: "0x1234",
      gas: "0x186a0",
      maxFeePerGas: "0x5f5e100",
      maxPriorityFeePerGas: "0x0",
    });
    const broker = new ManualBroker(
      {
        id: "a".repeat(64),
        lane: "SWAP",
        reviewId: "synthetic",
        step: "SWAP",
        transaction: tx,
        expiresAt: Date.now() + 60000,
        serverTime: Date.now(),
        released: true,
      },
      (t, d) => ledger.append(t, d),
    );
    broker.claim(true);
    const handed = broker.handoff(tx);
    await broker.captured;
    broker.finish("SENT", hash);
    await handed;
    const start = Date.now();
    await expect(page.locator(".sc-record")).toHaveCount(1);
    await expect(page.locator(".sc-record")).toContainText("SUBMITTED");
    const ingestionMs = Date.now() - start;
    index.put({
      ...index.list(account)[0],
      status: "PENDING",
      tracking: {
        state: "SWAP_PENDING",
        steps: { SWAP: { state: "PENDING" } },
      },
      updatedAt: Date.now(),
    });
    await expect(page.locator(".sc-record")).toContainText("PENDING");
    index.store.close();
    index = new ScanIndex(join(dir, "index"));
    await page.reload();
    await expect(page.locator(".sc-record")).toHaveCount(1);
    await expect(page.locator(".sc-record")).toContainText(hash);
    await page.screenshot({
      path: "../evidence/screenshots/scan-automatic-ingestion-SYNTHETIC.png",
      fullPage: true,
    });
    writeFileSync(
      "../evidence/automatic-ingestion-e2e.json",
      JSON.stringify(
        {
          synthetic: true,
          transport: "Playwright interception",
          productionGateChanged: false,
          actualBroker: true,
          actualDurableStore: true,
          actualScanIndex: true,
          hashEnteredByUser: false,
          ingestionMs,
          restartRecovered: true,
          duplicateRows: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    index.store.close();
    ledger.close();
  }
});
