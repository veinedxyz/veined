import { LogoImage } from "./logo-image";
import { networkIdentity, type NetworkId } from "../content/networks";
import { networkThemeClass } from "../content/network-themes";

export function NetworkLogo({
  id,
  size = "md",
}: {
  id: NetworkId;
  size?: "sm" | "md" | "lg";
}) {
  const network = networkIdentity[id];
  return (
    <span
      className={`network-mark network-mark-${size} ${networkThemeClass(id)}`}
      data-network-logo={id}
      aria-hidden="true"
    >
      <LogoImage src={network.logo} size={40} />
    </span>
  );
}

export function NetworkBadge({
  id,
  compact = false,
}: {
  id: NetworkId;
  compact?: boolean;
}) {
  return (
    <span
      className={`network-badge ${networkThemeClass(id)}`}
      data-network={id}
    >
      <NetworkLogo id={id} size="sm" />
      <span>
        {compact ? networkIdentity[id].shortName : networkIdentity[id].name}
      </span>
    </span>
  );
}

export function RouteIdentity({ compact = false }: { compact?: boolean }) {
  return (
    <div className="route-identity">
      <NetworkBadge id="onechain" compact={compact} />
      <svg
        className="route-arrow"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          d="M4 12h16m-6-6 6 6-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <NetworkBadge id="bsc" compact={compact} />
    </div>
  );
}
