import Image from "next/image";
import {
  networkIdentity,
  networkStyle,
  type NetworkId,
} from "../content/networks";

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
      className={`network-mark network-mark-${size}`}
      style={networkStyle(id)}
      data-network-logo={id}
      aria-hidden="true"
    >
      <Image src={network.logo} alt="" width={40} height={40} unoptimized />
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
    <span className="network-badge" style={networkStyle(id)} data-network={id}>
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
