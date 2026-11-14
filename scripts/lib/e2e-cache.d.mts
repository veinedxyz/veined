export type CacheOwner = { pid: number; created: string };
export function rotateReproductionCache(options: {
  directory: string;
  cwd: string;
  expectedOwner: CacheOwner | null;
  currentOwner: CacheOwner | null;
}): {
  at: string;
  root: string;
  owner: CacheOwner;
  source: string;
  destination: string | null;
  rotated: boolean;
  deletedFiles: number;
  freshDevCache: boolean;
};
