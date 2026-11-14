export const DEFAULT_E2E_ORIGIN: string;
export function parseE2EOrigin(raw?: string): {
  origin: string;
  host: string;
  port: number;
};
export function isolatedTestHost(
  env: Record<string, string | undefined>,
): string | null;
