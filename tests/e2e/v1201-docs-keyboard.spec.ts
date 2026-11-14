import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

interface SelectiveHydrationProbe {
  injected: boolean;
  inputPresent: boolean;
  interactiveAtInjection: string | null;
  stoppedKeys: number;
  csp: string[];
}

for (const [width, locale] of [
  [1440, "en"],
  [390, "ar"],
] as const)
  test(`V1201 Docs ${width} ${locale}: capture shortcut before React stops a selective-hydration event`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.addCookies([
      { name: "otherbridge.locale", value: locale, url: baseURL! },
    ]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const state = window as typeof window & {
        docsSelectiveHydration: SelectiveHydrationProbe;
      };
      const probe: SelectiveHydrationProbe = (state.docsSelectiveHydration = {
        injected: false,
        inputPresent: false,
        interactiveAtInjection: null as string | null,
        stoppedKeys: 0,
        csp: [] as string[],
      });
      const add = EventTarget.prototype.addEventListener;
      const stop = Event.prototype.stopPropagation;
      document.addEventListener("securitypolicyviolation", (event) => {
        probe.csp.push(event.violatedDirective);
      });
      Event.prototype.stopPropagation = function () {
        if (
          this instanceof KeyboardEvent &&
          this.type === "keydown" &&
          this.key.toLowerCase() === "k"
        )
          probe.stoppedKeys++;
        stop.call(this);
      };
      // Trigger at the real React capture-listener registration boundary, while
      // the SSR input exists but its component is still dehydrated. The former
      // bubble listener deterministically missed this event. No timing sleep or
      // application readiness is substituted for the early-key assertion.
      EventTarget.prototype.addEventListener = function (
        type,
        listener,
        options,
      ) {
        add.call(this, type, listener, options);
        const capture =
          options === true ||
          (typeof options === "object" && options.capture === true);
        if (
          this === document &&
          type === "keydown" &&
          capture &&
          (window as unknown as Record<symbol, unknown>)[
            Symbol.for("veined.docs.shortcut")
          ] &&
          !probe.injected
        ) {
          probe.injected = true;
          queueMicrotask(() => {
            const input = document.getElementById("docs-search");
            probe.inputPresent = input instanceof HTMLInputElement;
            probe.interactiveAtInjection =
              input?.getAttribute("data-interactive") ?? null;
            input?.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "k",
                code: "KeyK",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        }
      };
    });
    // Keep the search boundary dehydrated until the early key has traversed
    // the real React listener. With its module already available, React may
    // finish hydration synchronously and legitimately never stop that key.
    let releaseModule!: () => void;
    const moduleGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    let heldModules = 0;
    await page.route(
      /\/_next\/static\/.*docs-search.*\.js(?:\?|$)/,
      async (route) => {
        heldModules++;
        await moduleGate;
        await route.continue();
      },
    );
    const search = page.locator("#docs-search");
    try {
      await page.goto("/docs", { waitUntil: "commit" });
      await page.waitForFunction(() => {
        const probe = (
          window as typeof window & {
            docsSelectiveHydration?: SelectiveHydrationProbe;
          }
        ).docsSelectiveHydration;
        return probe?.injected && probe.interactiveAtInjection !== null;
      });
      expect(heldModules).toBeGreaterThan(0);
      await expect(search).toHaveAttribute("data-interactive", "false");
    } finally {
      releaseModule();
    }
    await expect(search).toHaveAttribute("data-interactive", "true");
    const probe = await page.evaluate(
      () =>
        (
          window as typeof window & {
            docsSelectiveHydration: SelectiveHydrationProbe;
          }
        ).docsSelectiveHydration,
    );
    expect(probe.injected).toBe(true);
    expect(probe.inputPresent).toBe(true);
    expect(probe.interactiveAtInjection).toBe("false");
    expect(probe.stoppedKeys).toBeGreaterThan(0);
    await expect(search).toBeFocused();
    await page.keyboard.type("fee");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar" ? "rtl" : "ltr",
    );
    expect(probe.csp).toEqual([]);
    expect(errors).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

for (const [width, locale] of [
  [1440, "en"],
  [390, "ar"],
] as const)
  test(`V1201 Docs ${width} ${locale}: shortcut before hydration, retained text and one listener across navigation`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.addCookies([
      { name: "otherbridge.locale", value: locale, url: baseURL! },
    ]);
    const errors: string[] = [],
      violations: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { csp: string[] }).csp ??= [];
        (window as unknown as { csp: string[] }).csp.push(
          event.violatedDirective,
        );
      }),
    );
    let release!: () => void;
    const scripts = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
      await scripts;
      await route.continue();
    });
    await page.goto("/docs", { waitUntil: "commit" });
    const search = page.locator("#docs-search");
    try {
      await expect(search).toBeVisible();
      await expect(search).toHaveAttribute("data-interactive", "false");
      await page.keyboard.press("Control+k");
      await expect(search).toBeFocused();
      await page.keyboard.type("fee");
      await expect(search).toHaveValue("fee");
      await expect(search).toHaveAttribute("data-interactive", "false");
    } finally {
      release();
    }
    await expect(search).toHaveAttribute("data-interactive", "true");
    await expect(search).toHaveValue("fee");
    await expect(page.getByRole("listbox")).toBeVisible();
    for (let round = 0; round < 3; round++) {
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await expect(page.getByRole("listbox")).toBeHidden();
      await page.keyboard.press(round === 1 ? "Meta+k" : "Control+k");
      await expect(search).toBeFocused();
      await search.fill("fee");
      await expect(page.getByRole("listbox")).toBeVisible();
    }
    await page.keyboard.press("Escape");
    if (width === 390) await page.locator(".dk-mobile-nav summary").click();
    await page
      .locator(
        `${width === 390 ? ".dk-mobile-nav" : ".dk-desktop-nav"} nav a[href="/docs/safety"]`,
      )
      .click();
    await expect(page).toHaveURL(/\/docs\/safety$/);
    await expect(search).toHaveAttribute("data-interactive", "true");
    await page.goBack();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(search).toHaveAttribute("data-interactive", "true");
    await search.evaluate((input) => {
      const field = input as HTMLInputElement;
      const focus = field.focus.bind(field);
      field.dataset.focusCalls = "0";
      field.focus = (...args) => {
        field.dataset.focusCalls = String(Number(field.dataset.focusCalls) + 1);
        focus(...args);
      };
    });
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("data-focus-calls", "1");
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "ar" ? "rtl" : "ltr",
    );
    violations.push(
      ...(await page.evaluate(
        () => (window as unknown as { csp?: string[] }).csp ?? [],
      )),
    );
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
