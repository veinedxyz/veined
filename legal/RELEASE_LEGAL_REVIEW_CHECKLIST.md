# Release legal/privacy review checklist

Status: LEGAL_REVIEW_REQUIRED. Engineering provides facts/questions only; no final legal conclusion or approval.

- Review Privacy Policy, Terms, wallet/public-chain identifiers and HMAC pseudonyms, IP/proxy/rate-limit handling, log/backup retention, deletion requests and public-chain immutability.
- Disclose third-party RPC, quote, metadata, Privy/WalletConnect and monitoring/hosting processors; evaluate transfers, vendor logging and contractual data use.
- Review trading/slippage, price impact, routing/provider competition and unsigned simulation limitations; token-import risk, incomplete valuation/coverage, failed/partial state and noncustodial wording.
- Determine restricted jurisdictions, sanctions, KYC/permissioned-token behavior and whether the planned service needs additional controls. Do not infer suitability from technical availability.
- Review every provider's service terms, commercial access, quotas, fees, attribution and onboarding.
- Review final root/provider/dev SBOM licenses, undeclared licenses, local reviewed SDK patch, source licenses and asset attributions. No technical license declaration is a legal acceptance.
- Approve hosting, security/incident contacts, retention/encryption policy and publication of legal copy before release.

Supporting documents: docs/PROVIDER_TERMS_REVIEW.md, docs/PRIVACY_DATA_INVENTORY.md, docs/THIRD_PARTY_RELEASE_LICENSES.md, docs/SECRET_CUSTODY.md and owner manifest. Counsel/owner approval must reference the exact RC and reviewed policy versions.
