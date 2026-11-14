# VEINED V1.20 asset manifest

Recommended owner-review candidate: **Quiet Current**. Owner approval is open; execution remains closed.

All public exports live under `public/assets/veined/brand/`. Editable source geometry and SVG masters live under `scripts/brand-sources/`, inside the existing source-checkpoint inventory scope. Reproduce with `node scripts/v120-brand-assets.mjs`; no dependency or lockfile changes are needed.

The machine-readable `asset-manifest.json` records source SHA-256, output SHA-256, dimensions, SVG sanitization and generator versions. The manifest excludes its own hash to avoid self-reference; the RC inventory covers it. Original, font-independent VEINED lettering is path geometry; supporting social-card copy is locally rendered Arial/system sans-serif. No external resources, raster logo traces, scripts or foreignObject are accepted.

Light/dark wordmark names describe the **ink color**: `wordmark-light.svg` is ivory for dark backgrounds; `wordmark-dark.svg` is graphite for light backgrounds. The icon/lockup `*-light.svg` concept variants describe the **target background**. `primary-logo.svg` and `primary-icon.svg` target dark surfaces. `logo-on-light.svg` and `icon-on-light.svg` target light surfaces.

The PWA maskable mark uses a 22% inset and is wholly inside the centered 80%-diameter safe circle. Favicon ICO has 16, 32, 48 and 64 pixel PNG frames. OG and Twitter/X cards are 1200 × 630; X banner is 1500 × 500; social avatar is 1024 × 1024; GitHub avatar is 512 × 512. Planned @veinedxyz is text only, never an active profile link.

89 exported assets; sizes and hashes below are generated from actual bytes.

| Asset | Bytes | Dimensions / ICO frames | SHA-256 |
| --- | ---: | --- | --- |
| `apple-touch-icon.png` | 3901 | 180 × 180 | `3c5e2f01afe4f92f11d2ce9dbbe6d63e9f62cb9c53ab1a791c38ba7b98d07562` |
| `comparison.png` | 127589 | 1600 × 1080 | `2ce82e65b8a95ecdfb392482ddb53b1c66c2b48ce10b8d634ea060ca95bdd3a5` |
| `comparison.svg` | 19499 | 1600 × 1080 | `d03567cc35c356cec86e87f3cdcceabf4ad7a1f845d0b7e395e3cc7d739690dd` |
| `concepts/a-vein-nexus/dark-background.svg` | 1886 | 376 × 96 | `8bf4710500da7c7b09494954625647b9816d1dc279acb59b34d5272202f0972c` |
| `concepts/a-vein-nexus/icon-light.svg` | 1331 | 128 × 128 | `eba0e71b136b4aaad576a5501c1840693073c76973421a3caa2c5676c9d308ac` |
| `concepts/a-vein-nexus/icon.svg` | 1331 | 128 × 128 | `42766b1d0e16bb5d1e0146bd4aa9b9f86029fa87ad404d19afc0d401ac760fc5` |
| `concepts/a-vein-nexus/light-background.svg` | 1886 | 376 × 96 | `217bcbe54c127493961edb3d99561c6d17fc98d59ebde78f143ba225c1278216` |
| `concepts/a-vein-nexus/lockup-light.svg` | 1832 | 376 × 96 | `d37ebd2f30d446a42588674f4d61b7badd2ce79527fa0865ba5473484d557a6e` |
| `concepts/a-vein-nexus/lockup.svg` | 1832 | 376 × 96 | `7d3f53b13a22dbc44d5bab4b9cc231867f8c32177a49d1a272648922aaa96334` |
| `concepts/a-vein-nexus/mono-dark.svg` | 1331 | 128 × 128 | `75af3e506348cb4de56da2e01eabe31b366c4cbda30cdb87605d8d42beb9155d` |
| `concepts/a-vein-nexus/mono-white.svg` | 1331 | 128 × 128 | `2555e02b88fa4236f4a92e2262bf4f5e5637758fe9fd06645dac33ab23d923a3` |
| `concepts/a-vein-nexus/preview-128.png` | 4732 | 128 × 128 | `7d694cf38d27b8ed9c44f2716abacc9b329a548fb84151c795f1ec593e23599c` |
| `concepts/a-vein-nexus/preview-16.png` | 565 | 16 × 16 | `8ef37a5dbeaf95192c11888af500fec1d3d95d31ca34362a6a7427ea8eaec556` |
| `concepts/a-vein-nexus/preview-24.png` | 868 | 24 × 24 | `f09cc2af5e04807a4f0e57962d320910911f9508ea300065416a7f7cc8c569f5` |
| `concepts/a-vein-nexus/preview-256.png` | 9900 | 256 × 256 | `94e031ab9189a0bc4630cdd23e9eaf4dcec6ab706744470a29b2d38e5cd4336c` |
| `concepts/a-vein-nexus/preview-32.png` | 1189 | 32 × 32 | `28c8261006fc66630e57181373fe6e69cf8d8ab1926ec23ada6f6034c5bc89fa` |
| `concepts/a-vein-nexus/preview-64.png` | 2344 | 64 × 64 | `6cd78e070ba051e0e702147a58dfee2aed6a2c492b5f74533239728004b8601b` |
| `concepts/a-vein-nexus/preview-light-128.png` | 4786 | 128 × 128 | `703fafd71912a96da2e923988d5267fb72bc02082138c91d6d9737cae183c87c` |
| `concepts/a-vein-nexus/preview-light-16.png` | 577 | 16 × 16 | `7022f62fe225ef356d5f359db10bb6077bbbcbd82e4781924cf56def1c55cb82` |
| `concepts/a-vein-nexus/preview-light-24.png` | 889 | 24 × 24 | `106292f18a90d86e478cdac34caa16bb0ae41a34f23ce258a54790d82884c5c2` |
| `concepts/a-vein-nexus/preview-light-256.png` | 10044 | 256 × 256 | `3a22e5fd301c774d03854e434daa2807e139fc97b27f1de608dfdfa1eeab79e6` |
| `concepts/a-vein-nexus/preview-light-32.png` | 1202 | 32 × 32 | `411e042ffe98b610bffd1dda09a83de5c7219219e09b4f69697be6e338bb889c` |
| `concepts/a-vein-nexus/preview-light-64.png` | 2418 | 64 × 64 | `b078881e0c142c5eede8e74b6daddf3a7d72e52738ea679142cecbf477eabd7e` |
| `concepts/a-vein-nexus/wordmark-light.svg` | 594 | 232 × 42 | `a98a2f36e8b42ea2473b035fa8764f2c7b2c7ad63300eefeb83daaa22e936049` |
| `concepts/a-vein-nexus/wordmark.svg` | 594 | 232 × 42 | `09023474abea0538f17a08f57cd42e4264be4b64d491e34da8d5973a865f4734` |
| `concepts/b-mantle-graph/dark-background.svg` | 1126 | 376 × 96 | `c2a1235f3b0f4bad885a9752963af7d0bb86b709ae0e8d54297c3db15761edda` |
| `concepts/b-mantle-graph/icon-light.svg` | 571 | 128 × 128 | `e0474f9a6d6c2ce086e0f57274748b37003ace162338e263d6f98f76643f7c7d` |
| `concepts/b-mantle-graph/icon.svg` | 571 | 128 × 128 | `ada91fc699cd8e5da496f55b8ec45d8eb1ba5baffbafb4686e5ec30f440d08c0` |
| `concepts/b-mantle-graph/light-background.svg` | 1126 | 376 × 96 | `ce210a8d3a76dca06199e8d7b3ea6702092f1f801870ad1ece40f34864b198df` |
| `concepts/b-mantle-graph/lockup-light.svg` | 1072 | 376 × 96 | `23481db99179abb96a81e782658b79055ea5b0fec9947bd67dfc245eab63e5e7` |
| `concepts/b-mantle-graph/lockup.svg` | 1072 | 376 × 96 | `8bb4642bffce7b90106871580016bc4c24e65010575360c90dc15552f9ff89a3` |
| `concepts/b-mantle-graph/mono-dark.svg` | 571 | 128 × 128 | `856f91b39b0b9bb33393c56172326fdfab9fd9ee0cc4f064d064ad5449b4d158` |
| `concepts/b-mantle-graph/mono-white.svg` | 571 | 128 × 128 | `abe120c20fe9ecd21eeeba0d4618a02ad6c66fe0c49020579b6d3ce0a99b3e4d` |
| `concepts/b-mantle-graph/preview-128.png` | 4890 | 128 × 128 | `dda3f3015cde59e61eb73b2e5f88d56c8e3b17dd976f44599fbc5c662fd517d1` |
| `concepts/b-mantle-graph/preview-16.png` | 522 | 16 × 16 | `118a40ae3d0cfcb21195965cad6f531fac623c226359d6eead6353b767f12659` |
| `concepts/b-mantle-graph/preview-24.png` | 902 | 24 × 24 | `9995702a21b2e033de48a11a0bde744739f87b402fe9f39e7973c5b4b3b979cf` |
| `concepts/b-mantle-graph/preview-256.png` | 10209 | 256 × 256 | `55109f4973a122778990294dbeb21592c6c69778b956362abd1c8ac88af08d5f` |
| `concepts/b-mantle-graph/preview-32.png` | 1171 | 32 × 32 | `6feb28ad97652fd76cb48a48c83d9d698132bcb8fc4ec8a884ad22ad6be9f003` |
| `concepts/b-mantle-graph/preview-64.png` | 2373 | 64 × 64 | `682931aaeaa6ada6c817df27cce3ab22868d88a40446161ab5bb6524eb9f63e8` |
| `concepts/b-mantle-graph/preview-light-128.png` | 4903 | 128 × 128 | `e29b7281aaf50c57b04d9f9a6f2393eaa8ff34b80773efc8908ae9eb1701e6e8` |
| `concepts/b-mantle-graph/preview-light-16.png` | 534 | 16 × 16 | `6a5c612ad7ab07a014ad76d32fe3bb8f49c1d35fb87149472a54bfde410f92bc` |
| `concepts/b-mantle-graph/preview-light-24.png` | 915 | 24 × 24 | `f1fc0f2f9cef0a193d038eb087ccb8b6af1963423629469c60ad7cba8c493ace` |
| `concepts/b-mantle-graph/preview-light-256.png` | 10284 | 256 × 256 | `dbbe67e169ba9c38cfc4073f66b5a59cc31ff705fd77d7285ed9cfc45d723271` |
| `concepts/b-mantle-graph/preview-light-32.png` | 1207 | 32 × 32 | `8f69f616d5c8ef6bfa2a3c72eda56f5824790d90b9b795ad11f0e793874ca84a` |
| `concepts/b-mantle-graph/preview-light-64.png` | 2441 | 64 × 64 | `b4ccc5bab12bcbc928fd4260d6b974d72cc286a4ebe67e3f2cf469b15b80a70d` |
| `concepts/b-mantle-graph/wordmark-light.svg` | 594 | 232 × 42 | `a98a2f36e8b42ea2473b035fa8764f2c7b2c7ad63300eefeb83daaa22e936049` |
| `concepts/b-mantle-graph/wordmark.svg` | 594 | 232 × 42 | `09023474abea0538f17a08f57cd42e4264be4b64d491e34da8d5973a865f4734` |
| `concepts/c-quiet-current/dark-background.svg` | 990 | 376 × 96 | `49a8622884e215ff23e159a8df900d08557431b7529a313e24fcc6b64268ab9c` |
| `concepts/c-quiet-current/icon-light.svg` | 435 | 128 × 128 | `afe18dc38b56d5edb0396674e2eba700e5a17ac13042cf80bd6e0830f442a997` |
| `concepts/c-quiet-current/icon.svg` | 435 | 128 × 128 | `6242d8b9932c5b8a21d9c516c7d6bcde9d0c355ff9e53540664abfc5b6b07ed3` |
| `concepts/c-quiet-current/light-background.svg` | 990 | 376 × 96 | `9eb6926abb0fbf6d76267cfce7b55996ff241b1439cc051c2ac8670808e582bf` |
| `concepts/c-quiet-current/lockup-light.svg` | 936 | 376 × 96 | `7e7300462352e4992293e476dc95ad9e504eae3a180a8daa2692b770de90b609` |
| `concepts/c-quiet-current/lockup.svg` | 936 | 376 × 96 | `1c8fcd82ea366fa8466eb72a7ca1dd429df6469875e896feac5410088e43a7bf` |
| `concepts/c-quiet-current/mono-dark.svg` | 435 | 128 × 128 | `80380b1d306ac17fb37a518d4cdd5482c3bfb37786c8f44789b39f58fe274989` |
| `concepts/c-quiet-current/mono-white.svg` | 435 | 128 × 128 | `da2ad73709e797e94bc898b22a8fdedd6193a5aefec78380f41ae698578232ee` |
| `concepts/c-quiet-current/preview-128.png` | 3450 | 128 × 128 | `e49f3a7de87db43fc3b858fac567cbbe87a988396be13e0ce2638beb0f65ebfd` |
| `concepts/c-quiet-current/preview-16.png` | 467 | 16 × 16 | `617ae5d8d5ee19160ec04b71f5776942d52afea3fc96923415afad6cf89bb3a4` |
| `concepts/c-quiet-current/preview-24.png` | 700 | 24 × 24 | `dec434bc335e21a78c060e1f26efc122b8396384cf53d70d735cc2fab05da00c` |
| `concepts/c-quiet-current/preview-256.png` | 6935 | 256 × 256 | `268b2f76693bce169f604f9b7fec3f9f8666fa5571822deaeda885ee35040bfa` |
| `concepts/c-quiet-current/preview-32.png` | 893 | 32 × 32 | `8420bf118954decb5aabfa433250bf5b50c96bcf74708cc92d73dfa96df42943` |
| `concepts/c-quiet-current/preview-64.png` | 1736 | 64 × 64 | `0378eaca255c97a8eee9fdd71a80094980b1ffd3b18f99c792a37c0b250a7125` |
| `concepts/c-quiet-current/preview-light-128.png` | 3473 | 128 × 128 | `3997426252bf4fa08b84fde158ad332425c5dcc0d961a1306a842cd140503a9e` |
| `concepts/c-quiet-current/preview-light-16.png` | 484 | 16 × 16 | `b79e2f933a86f7b5f787664fba0b01c31a17a26e07d14169aa9dd2d907d5bef6` |
| `concepts/c-quiet-current/preview-light-24.png` | 706 | 24 × 24 | `65d96182fe32e04ce7c296486951ff0915ebfbf9e1fd179b40e84ef797233011` |
| `concepts/c-quiet-current/preview-light-256.png` | 7023 | 256 × 256 | `8cd06a1012aaa554d66938f46f3cffc393c9afd449772f6e5dab3afa9228fac4` |
| `concepts/c-quiet-current/preview-light-32.png` | 925 | 32 × 32 | `2a9b46ca9915aede0427afa6e8bae0e9aca0177efb57b9c706a1fcd4fc8a0ea1` |
| `concepts/c-quiet-current/preview-light-64.png` | 1760 | 64 × 64 | `3c6cac5784d716ec5d53ba9a0d026465c884c17ff472b7bb0a0a563929c6ca0c` |
| `concepts/c-quiet-current/wordmark-light.svg` | 594 | 232 × 42 | `a98a2f36e8b42ea2473b035fa8764f2c7b2c7ad63300eefeb83daaa22e936049` |
| `concepts/c-quiet-current/wordmark.svg` | 594 | 232 × 42 | `09023474abea0538f17a08f57cd42e4264be4b64d491e34da8d5973a865f4734` |
| `favicon.ico` | 2942 | 16, 32, 48, 64 | `159c95ff8645b285d3f1b2e59ad2fdf903f8c60ba3773532f0242caf76789d7e` |
| `favicon.svg` | 528 | 64 × 64 | `ee49ed674adc4170488948c29d87e6d99eef9e6832187dce37111881e5877250` |
| `github-avatar.png` | 12813 | 512 × 512 | `6db1a5e641015e9c18aea3d1950601a98445638db1b2215768d1133e53b57f8d` |
| `icon-192.png` | 4185 | 192 × 192 | `6ad17d2382636ef4dbc4aced5861536da690f6779ba26a6e3645c5d91bf1c60b` |
| `icon-512.png` | 12813 | 512 × 512 | `6db1a5e641015e9c18aea3d1950601a98445638db1b2215768d1133e53b57f8d` |
| `icon-on-light.svg` | 435 | 128 × 128 | `afe18dc38b56d5edb0396674e2eba700e5a17ac13042cf80bd6e0830f442a997` |
| `logo-mono-dark.svg` | 936 | 376 × 96 | `447cfb2f7c186d14925cd3c16c08d04e2c69afca78f60192ef1b8f4c0f527634` |
| `logo-mono-white.svg` | 936 | 376 × 96 | `7e610fed4ca7a76e0f527fe0fe965b07deb11c59e40d3abf44d885831eca9b96` |
| `logo-on-light.svg` | 936 | 376 × 96 | `7e7300462352e4992293e476dc95ad9e504eae3a180a8daa2692b770de90b609` |
| `maskable-icon-512.png` | 10330 | 512 × 512 | `1b54f2169abe7d508dd0b4be0c844260f221137d55c76c139d8f55cdb111f1dc` |
| `og-image.png` | 78154 | 1200 × 630 | `b0d26d3d6ad7868ce2d22f6f5ee16b99777d91092153f85641f10b5e52f5e4e7` |
| `primary-icon.svg` | 435 | 128 × 128 | `6242d8b9932c5b8a21d9c516c7d6bcde9d0c355ff9e53540664abfc5b6b07ed3` |
| `primary-logo.svg` | 936 | 376 × 96 | `1c8fcd82ea366fa8466eb72a7ca1dd429df6469875e896feac5410088e43a7bf` |
| `review.css` | 4232 | — | `408dc1adf40ed33016423378b8f13218ff11da13f1a55a7b029ff81ab1b42b58` |
| `review.html` | 11947 | — | `7743f6a14d444a7c3cfe5ba2b9094851d568e71fe5a83166f5e6335623153e7a` |
| `social-avatar.png` | 28370 | 1024 × 1024 | `1aa1572f3dcc762ae6a12cce52f6286cb25bf1ed054a8b8abe6813ae268ade05` |
| `twitter-card.png` | 78154 | 1200 × 630 | `b0d26d3d6ad7868ce2d22f6f5ee16b99777d91092153f85641f10b5e52f5e4e7` |
| `wordmark-dark.svg` | 594 | 232 × 42 | `a98a2f36e8b42ea2473b035fa8764f2c7b2c7ad63300eefeb83daaa22e936049` |
| `wordmark-light.svg` | 594 | 232 × 42 | `09023474abea0538f17a08f57cd42e4264be4b64d491e34da8d5973a865f4734` |
| `x-banner.png` | 78079 | 1500 × 500 | `2181ef7dd4aed16c70b149e92e9f0d6e190750e09cbfda659bcac5392b99b960` |
