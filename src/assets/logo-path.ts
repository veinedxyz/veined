// Same-origin sanitized registry/cache images only. A display symbol cannot identify a logo.
export function isAssetLogoSrc(src: string) {
  return (
    typeof src === "string" &&
    src.length <= 200 &&
    !src.includes("..") &&
    !src.includes("//") &&
    /^\/(assets\/(tokens|chains|official)\/[A-Za-z0-9/_.-]+|api\/asset-image\/[0-9a-f]{64})$/.test(
      src,
    )
  );
}
