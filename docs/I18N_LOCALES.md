# Shipped Otherbridge V1.3 locales

All 24 locales ship the exact canonical 362 message leaves. Build rejects missing, obsolete, empty or malformed keys. A locale is active only after its complete dictionary validates. No per-key English fallback is used.

| Locale | Native name | Direction | Keys |
|---|---|---|---|
| tr | Türkçe | LTR | 362 |
| en | English | LTR | 362 |
| es | Español | LTR | 362 |
| pt-BR | Português (Brasil) | LTR | 362 |
| fr | Français | LTR | 362 |
| de | Deutsch | LTR | 362 |
| it | Italiano | LTR | 362 |
| nl | Nederlands | LTR | 362 |
| pl | Polski | LTR | 362 |
| ru | Русский | LTR | 362 |
| uk | Українська | LTR | 362 |
| ar | العربية | RTL | 362 |
| fa | فارسی | RTL | 362 |
| he | עברית | RTL | 362 |
| ur | اردو | RTL | 362 |
| zh-CN | 简体中文 | LTR | 362 |
| zh-TW | 繁體中文 | LTR | 362 |
| ja | 日本語 | LTR | 362 |
| ko | 한국어 | LTR | 362 |
| hi | हिन्दी | LTR | 362 |
| bn | বাংলা | LTR | 362 |
| id | Bahasa Indonesia | LTR | 362 |
| vi | Tiếng Việt | LTR | 362 |
| th | ไทย | LTR | 362 |

English is the fallback for an unsupported locale preference/browser language, not missing translations. Locale URLs are unchanged. See I18N_ARCHITECTURE.md for preference precedence and I18N_TEST_MATRIX.md for test boundaries.

## V1.14.2 note

The table above is the V1.3 record. At V1.14.2 every locale ships 1,009 canonical leaves (`pnpm i18n:check`). The three
new `v1142.*` progressive-scan messages (`scanningPriority`, `scanningRemaining`, `progressCounts`) are canonical in EN /
TR and machine-assisted in the other 22 locales, pending native review; the no-fallback policy is unchanged (a locale
activates only with its complete dictionary). RTL rendering of the phase line is covered by `tests/e2e/v1142.spec.ts`.
