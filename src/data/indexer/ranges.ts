// Adaptive eth_getLogs ranges: shrink on range/size/time errors, grow cautiously after streaks.
export class RangeController {
  private streak = 0;
  // Learned ceiling: never grow back to a size that already failed on this run.
  private ceiling = Infinity;
  constructor(
    private current: number,
    private readonly max: number,
    private readonly min = 1,
    private readonly growAfter = 3,
    private readonly targetLogs = 4000,
  ) {
    if (min < 1 || max < min) throw Error("INVALID_RANGE_BOUNDS");
    this.current = Math.min(max, Math.max(min, Math.floor(current)));
  }
  get size() {
    return this.current;
  }
  success(logCount: number) {
    if (logCount > this.targetLogs * 2) {
      this.current = Math.max(this.min, Math.floor(this.current / 2));
      this.streak = 0;
      return;
    }
    this.streak++;
    if (this.streak >= this.growAfter && logCount < this.targetLogs / 2) {
      this.current = Math.max(
        this.min,
        Math.min(this.max, this.ceiling - 1, this.current * 2),
      );
      this.streak = 0;
    }
  }
  // Returns false when already at the minimum: the caller must stop instead of looping forever.
  failure(): boolean {
    this.streak = 0;
    this.ceiling = Math.min(this.ceiling, this.current);
    if (this.current <= this.min) return false;
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    return true;
  }
}
