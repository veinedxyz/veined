import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { readFile, mkdir } from "node:fs/promises";
import { CROSS, type TransferRecord } from "../../src/core/model";
import { verifySettlement } from "../../src/core/flow";
import {
  decodeNativeSource,
  decodeNativeDestination,
} from "../../src/adapters/native-decoder";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import {
  intentLockKey,
  mainnetNamespace,
} from "../../src/features/bridge/lifecycle";
const evidence = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1"}/screenshots`;
test("C3 reload never trusts rejection; manual hash preserves history and requires decoder proof", async ({
  page,
}) => {
  await mkdir(evidence, { recursive: true });
  const raw = JSON.parse(
    await readFile(
      "evidence/otherbridge-v1/repair-r1/live/public-settlement.json",
      "utf8",
    ),
  ).sample;
  const claim: TransferRecord = {
    schema: 1,
    id: "manual-readonly-recovery",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account: raw.sourceTransaction.from,
    recipient: raw.sourceTransaction.from,
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "12094599106825003813",
    expected: "12094599106825003813",
    state: "USER_REJECTED",
    updatedAt: Date.now(),
  };
  await page.addInitScript((claim) => {
    // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "tr");
    if (!localStorage.getItem("otherbridge.history.v1"))
      localStorage.setItem(
        "otherbridge.history.v1",
        JSON.stringify([claim, { ...claim, id: "preserved-other-intent" }]),
      );
    Object.assign(window, {
      walletMethods: [] as string[],
      ethereum: {
        request: ({ method }: { method: string }) => {
          (window as unknown as { walletMethods: string[] }).walletMethods.push(
            method,
          );
          throw Error("NO_WALLET_ACCESS");
        },
      },
    });
  }, claim);
  let allow = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy = {
    sourceContract: deployment.source,
    destinationContract: deployment.destination,
    sourceConfirmations: 1,
    destinationConfirmations: 1,
    finality: "node-finalized" as const,
  };
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
          observedAt: Date.now(),
          status: "blocked",
          reasons: ["MAINNET_WRITE_DISABLED"],
        },
      });
    if (body.action !== "track") throw Error("UNEXPECTED_API");
    if (!body.record.sourceHash)
      return route.fulfill({
        json: {
          kind: "chain",
          observedAt: Date.now(),
          record: {
            ...body.record,
            state: "SUBMISSION_UNKNOWN",
            error: "MANUAL_ACTION_REQUIRED",
          },
          evidence: { policy },
        },
      });
    if (!allow) await held;
    const source = decodeNativeSource(body.record, {
      receipt: raw.sourceReceipt,
      transaction: raw.sourceTransaction,
      block: raw.sourceBlock,
      finalized: raw.sourceFinalized,
      chainId: 612055,
    });
    const record = {
      ...body.record,
      index: source.index,
      destinationHash: raw.destinationTransaction.hash,
    };
    const destination = decodeNativeDestination(record, source, {
      receipt: raw.destinationReceipt,
      transaction: raw.destinationTransaction,
      block: raw.destinationBlock,
      finalized: raw.destinationFinalized,
      chainId: 56,
    });
    await route.fulfill({
      json: {
        kind: "chain",
        observedAt: Date.now(),
        record: {
          ...record,
          state: verifySettlement(record, source, destination, policy),
          error: undefined,
        },
        evidence: { source, destination, policy },
      },
    });
  });
  await page.goto(`/activity/${claim.id}`);
  await expect(
    page.getByText("Bu oturumda ret doğrulanamıyor.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/manual-recovery-required-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}/manual-recovery-required-mobile.png`,
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByLabel("Kaynak hash", { exact: true })
    .fill(raw.sourceTransaction.hash);
  await page
    .getByRole("button", { name: "Hash’i kaydet ve salt okunur takip et" })
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page.evaluate(() =>
            localStorage.getItem("otherbridge.history.v1"),
          ))!,
        )[0].sourceHash,
    )
    .toBe(raw.sourceTransaction.hash);
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toHaveCount(0);
  allow = true;
  release();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toBeVisible();
  const records = JSON.parse(
    (await page.evaluate(() =>
      localStorage.getItem("otherbridge.history.v1"),
    ))!,
  );
  expect(records.map((r: TransferRecord) => r.id).sort()).toEqual(
    [claim.id, "preserved-other-intent"].sort(),
  );
  expect(
    records.find((r: TransferRecord) => r.id === "preserved-other-intent")
      .sourceHash,
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => (window as unknown as { walletMethods: string[] }).walletMethods,
    ),
  ).toEqual([]);
});
test("R1/F3 persisted mainnet completion needs fresh decoder proof after each reload", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(
      "evidence/otherbridge-v1/repair-r1/live/public-settlement.json",
      "utf8",
    ),
  );
  const raw = fixture.sample;
  const record: TransferRecord = {
    schema: 1,
    id: "public-native-ui-replay",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account: raw.sourceTransaction.from,
    recipient: raw.sourceTransaction.from,
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "12094599106825003813",
    expected: "12094599106825003813",
    sourceHash: raw.sourceTransaction.hash,
    state: "COMPLETED",
    updatedAt: Date.now(),
  };
  await page.addInitScript((claim) => {
    // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "tr");
    if (!localStorage.getItem("otherbridge.history.v1"))
      localStorage.setItem("otherbridge.history.v1", JSON.stringify([claim]));
    const walletMethods: string[] = [];
    Object.assign(window, {
      walletMethods,
      ethereum: {
        request: ({ method }: { method: string }) => {
          walletMethods.push(method);
          throw Error("NO_REAL_WALLET");
        },
      },
    });
  }, record);
  let tracks = 0;
  let allowProof = false;
  const waits: (() => void)[] = [];
  const release = () => {
    allowProof = true;
    waits.splice(0).forEach((resolve) => resolve());
  };
  await page.route("**/api/bridge", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { mode: "mainnet-readonly", submission: false, version: "1" },
      });
      return;
    }
    const body = route.request().postDataJSON();
    if (body.action === "health") {
      await route.fulfill({
        json: {
          mode: "mainnet-readonly",
          status: "blocked",
          observedAt: Date.now(),
          reasons: ["SOURCE_BUILD_MATCH_UNVERIFIED", "MAINNET_WRITE_DISABLED"],
          limits: {
            minimum: "5000000000000000000",
            maximumBound: "914341916876528660320617409",
            conservativeReserveBound: "914341916876528660320617409",
            paused: false,
            reserveVerified: false,
          },
        },
      });
      return;
    }
    if (body.action !== "track") throw Error("UNEXPECTED_API_REQUEST");
    tracks++;
    if (!allowProof) await new Promise<void>((resolve) => waits.push(resolve));
    const source = decodeNativeSource(body.record, {
      receipt: raw.sourceReceipt,
      transaction: raw.sourceTransaction,
      block: raw.sourceBlock,
      finalized: raw.sourceFinalized,
      chainId: 612055,
    });
    const verified = {
      ...body.record,
      index: source.index,
      destinationHash: raw.destinationTransaction.hash,
    };
    const destination = decodeNativeDestination(verified, source, {
      receipt: raw.destinationReceipt,
      transaction: raw.destinationTransaction,
      block: raw.destinationBlock,
      finalized: raw.destinationFinalized,
      chainId: 56,
    });
    const policy = {
      sourceContract: deployment.source,
      destinationContract: deployment.destination,
      sourceConfirmations: 1,
      destinationConfirmations: 1,
      finality: "node-finalized" as const,
    };
    verified.state = verifySettlement(verified, source, destination, policy);
    verified.updatedAt = Date.now();
    await route.fulfill({
      json: {
        kind: "chain",
        observedAt: Date.now(),
        record: verified,
        evidence: { source, destination, policy },
      },
    });
  });
  await page.goto(`/activity/${record.id}`);
  await expect.poll(() => tracks).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toBeVisible();
  const beforeReload = tracks;
  allowProof = false;
  await page.reload();
  await expect.poll(() => tracks).toBeGreaterThan(beforeReload);
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole("heading", { name: "Teslimat doğrulandı", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            JSON.parse(localStorage.getItem("otherbridge.history.v1")!),
          )
        )[0].state,
    )
    .toBe("COMPLETED");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: `${evidence}/native-history-replay-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}/native-history-replay-mobile.png`,
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const settledTrackCount = tracks;
  await page.waitForTimeout(1800);
  expect(tracks).toBe(settledTrackCount); // Dev StrictMode may mount twice, but fresh records must not restart polling.
  await page.goto("/bridge");
  // V1.11: observed bounds live in the health card's Safety details disclosure.
  await page
    .locator(".health-card details.disclosure > summary")
    .first()
    .click();
  await expect(page.getByText("Gözlenen minimum")).toBeVisible();
  await expect(
    page.getByText("Gerçek gönderim kapalı", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/native-health-bounds-mobile.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { walletMethods: string[] }).walletMethods,
    ),
  ).toEqual([]);
});
test("R1/F3 two real tabs exclude the same mainnet intent while local-test namespace is independent", async ({
  page,
  context,
}) => {
  await page.goto("/help");
  const account = "0x3333333333333333333333333333333333333333";
  const mainnet = intentLockKey(account, mainnetNamespace);
  const local = intentLockKey(account, {
    ...mainnetNamespace,
    mode: "local-test",
    sourceChain: 31337,
    destinationChain: 31338,
  });
  const held = page.evaluate(
    async (key) =>
      navigator.locks.request(key, async () => {
        const control = window as unknown as {
          lockHeld: boolean;
          releaseIntent: () => void;
        };
        control.lockHeld = true;
        await new Promise<void>((resolve) => {
          control.releaseIntent = resolve;
        });
      }),
    mainnet,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { lockHeld: boolean }).lockHeld,
      ),
    )
    .toBe(true);
  const second = await context.newPage();
  await second.goto("/help");
  expect(
    await second.evaluate(
      (key) =>
        navigator.locks.request(key, { ifAvailable: true }, (lock) =>
          Boolean(lock),
        ),
      mainnet,
    ),
  ).toBe(false);
  expect(
    await second.evaluate(
      (key) =>
        navigator.locks.request(key, { ifAvailable: true }, (lock) =>
          Boolean(lock),
        ),
      local,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { releaseIntent: () => void }).releaseIntent(),
  );
  await held;
  expect(
    await second.evaluate(
      (key) =>
        navigator.locks.request(key, { ifAvailable: true }, (lock) =>
          Boolean(lock),
        ),
      mainnet,
    ),
  ).toBe(true);
  await second.close();
});
