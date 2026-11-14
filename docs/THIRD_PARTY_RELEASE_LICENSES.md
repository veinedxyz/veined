# Third-party release licenses and attribution

The machine inventories are the four CycloneDX 1.6 BOMs in the current evidence dependencies/sbom directory: root production, provider production, root dev/test and provider dev/test. Each component records exact version, runtime/dev classification, lock SRI hash and license metadata or explicit NOASSERTION. Runtime dependencies shared with dev tooling stay classified as production.

Declared licenses are metadata, not commercial/service approval. Unresolved/undeclared identifiers remain LEGAL_REVIEW_REQUIRED. Review provider SDK licenses independently of HTTP API terms. The accepted local Pancake SDK patch is bound by the provider lock and must remain attributed with its upstream license.

Assets/source attribution references: ASSET_PROVENANCE.md, ASSET_REGISTRY.md, DEFI_SOURCE_LICENSE_INVENTORY.md and SWAP_PROVIDER_SOURCE_INVENTORY.md. Preserve third-party notices in the audit package. Do not label a missing license as permissive. No runtime package is moved to dev to hide an advisory. Provider elliptic6.6.1 LOW remains explicitly disclosed; root and provider High/Critical/Moderate must be zero.
