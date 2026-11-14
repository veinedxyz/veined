# V1.4 dependency high-finding repair (R4)

- Advisory: GHSA-vfj7-8cjw-p6xm (npm advisory id 1240992), `braces` ≤ 3.0.3, high, stack exhaustion through deeply nested brace/glob patterns. No patched version is published (registry versions end at 3.0.3).
- Path (before): `otherbridge (dev) → eslint-config-next@16.3.8 → @next/eslint-plugin-next@16.3.8 → fast-glob@3.3.1 → micromatch@4.0.8 → braces@3.0.3`. No other path existed (`pnpm why braces`, `pnpm why micromatch`).
- Reachability: development-only lint tooling. `pnpm audit --prod` reported no vulnerability before and after. `@next/eslint-plugin-next` calls `fast-glob` only in `utils/get-root-dirs.js` (`globSync(rootDir, { onlyDirectories: true })`) and only when `settings.next.rootDir` is configured; this repository configures none, so the default path returns `[context.cwd]`.

## Attempts, in the required order

1. Remove unused parent: not possible — `eslint-config-next` provides the accepted lint gate.
2. Replace the parent dependency with a safe maintained alternative: **applied at the vulnerable edge.** `pnpm-workspace.yaml` overrides `@next/eslint-plugin-next>fast-glob` with `npm:tinyglobby@0.2.17`. tinyglobby was already in the lockfile graph (used by typescript-eslint/vitest), is MIT, depends only on `fdir` and `picomatch@4` (no `braces`), and exports a compatible `globSync(pattern, { onlyDirectories })`.
3. Upgrade: the latest stable and canary `@next/eslint-plugin-next` (16.3.8 / 16.4.0-canary.59) still pin `fast-glob@3.3.1`; no fixed branch exists.
4./5. Not needed.

## Compatibility proof

- `evidence/.../dependency/override-code-path.json`: the plugin instance ESLint actually loads resolves `fast-glob` to `tinyglobby/dist/index.cjs`; the default code path and configured glob patterns return directories.
- `evidence/.../dependency/override-compare.json`: identical normalized results to the retired fast-glob@3.3.1 for glob patterns (`src/*/`, `src/*`, `src/{components,content}/`, non-matching); for a static trailing-slash directory (`src/app/`) tinyglobby returns a superset including descendants, which the rule only joins with `pages`/`app` and filters by existence. This shape is not used here.
- `pnpm lint` passes; `pnpm audit` (all deps) reports **0 vulnerabilities**; `pnpm why braces` / `micromatch` return nothing; install changed `+1 −16` packages (+postgres, −fast-glob/micromatch/braces/fill-range/to-regex-range and helpers).

Final state: high finding removed from both the development and production graphs without suppression or a forced untested override. Residual: the override must be re-evaluated when `@next/eslint-plugin-next` changes its glob dependency.
