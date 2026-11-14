# Otherbridge V1.2 internationalization

The canonical English nested dictionary defines typed dot-path keys; all 24 JSON dictionaries implement the same 313 leaves. Feature components use `useI18n()`/`translate()` and typed locales rather than TR/EN branches. The retained `content/messages.ts` exports preserve accepted compatibility tests while reading the canonical dictionaries.

## Resolution and rendering

Next 16.3.8 bundled i18n and async cookie guidance was read before implementation. The root layout resolves a supported `otherbridge.locale` cookie, then quality-sorted Accept-Language, then English. SSR emits the selected dictionary, translated title/description, `html.lang` and `html.dir`. There are no invented localized URL routes or hreflang links. Legacy `otherbridge.language` local storage migrates after hydration only when no locale cookie exists; explicit selection persists both cookie and local storage. Browser regional matches map Portuguese to pt-BR and Chinese script/region to zh-CN/zh-TW.

Locale selection lazy-loads supported dictionaries, validates them before activation, and uses a generation counter against racing selections. Load failure keeps the previous language and displays a translated error. Selected dictionaries are cached. English/Turkish are compatibility imports; other dictionaries are separate dynamic modules. There is no runtime translation service or per-key English fallback.

## Messages and validation

`i18n:check` runs before every production build and compares the exact locale file set, missing/obsolete keys, empty values, HTML and interpolation names against English. Runtime registration also validates. Missing keys, unloaded dictionaries and invalid parameters fail visibly during development/tests. Unknown API error/state codes map to localized safe messages; raw provider messages never become UI copy. Parameters are plain React text; raw HTML is prohibited. Intl.PluralRules selects localized `one`/`other` network forms; locale categories without a distinct form use that locale's `other` form. Technical identifiers, tokens, hashes, symbols and addresses stay unchanged.

## Financial meaning

Crypto values remain decimal strings/BigInt base units. `formatTokenAmount` groups the BigInt integer part and maps fractional digits without converting base units through floating point. Fiat and percentage presentation uses Intl.NumberFormat. Relative time uses Intl.RelativeTimeFormat. Arabic uses explicit Arabic digits; Persian/Urdu use explicit extended Arabic digits to avoid ICU-dependent Latin defaults.

Input accepts only a bounded positive decimal grammar after converting Arabic/Persian/full-width digits and the selected locale decimal separator. Whitespace, grouping separators, bidi controls, exponent notation, signs, excessive precision, mixed separators and ambiguous three-digit comma/group forms are rejected. API requests use canonical ASCII decimal strings. MAX uses the canonical base-unit formatter, never the localized display string. Core quote/accounting arithmetic is unchanged.

## RTL and responsive UI

Arabic, Persian, Hebrew and Urdu set RTL on SSR and after selection. CSS uses logical inline/block properties. Code, addresses, hashes and network IDs are LTR isolates; route identity stays source→destination in a deliberately LTR group so directional meaning and logos do not reverse. Dialogs trap focus, Escape closes and focus returns to the trigger. Search controls focus when their modal opens. Native language names use bdi and searchable text, without flag assumptions. Long labels wrap; system fallbacks cover CJK and RTL scripts without a remote font requirement.

## Translation quality and public presentation

New dictionaries were authored offline from machine-assisted drafts, then reviewed and corrected for financial meaning and critical warnings in every new locale. The canonical/TR baseline is preserved. Review covers balance versus custody, fees versus amounts, source confirmation versus delivery, reserve bound versus verified spendable reserve, revert versus success and explicit disabled sending. `i18n-authoring/semantic-review.json` preserves the review scope. This is model semantic review, not independent native-speaker certification; native language editorial review remains recommended before a production release. Build/runtime have no translation-service dependency.

All public locale dictionaries and rendered page text retain the accepted public-brand denylist. Technical/legal dependency identity stays in accepted internal records. Dictionary completeness is not evidence that G5 passed; all locales retain the G5/reserve/read-only warnings.
# V1.3 extension

All 24 accepted locales retain their 313 original leaves and add 49 authored Portfolio, Swap, catalog, ranking, security and favorites leaves (362 total). Full key/schema validation remains mandatory; no English fallback is introduced. New token amounts and addresses remain LTR within RTL layouts. Synthetic portfolio screens explicitly display the existing localized test-data notice. Locale dictionaries remain lazy; no new production dependency was added.
