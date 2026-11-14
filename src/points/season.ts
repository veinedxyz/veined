// Weekly epochs. Storage and arithmetic are UTC milliseconds; Europe/Istanbul is used for display and owner
// operations only. Season n (1-based) covers [start + (n-1)·week, start + n·week).
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DISPLAY_TIME_ZONE = "Europe/Istanbul";

export interface Schedule {
  seasonOneStartsAt: string;
  activatedAt: string;
}

const ms = (iso: string) => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw Error("INSTANT_INVALID");
  return value;
};

/** 0 before season 1, otherwise the 1-based season containing the instant. */
export function seasonAt(schedule: Schedule, at: Date | string): number {
  const t = typeof at === "string" ? ms(at) : at.getTime();
  const start = ms(schedule.seasonOneStartsAt);
  if (t < start) return 0;
  return Math.floor((t - start) / WEEK_MS) + 1;
}

export function seasonWindow(schedule: Schedule, season: number) {
  if (!Number.isInteger(season) || season < 1) throw Error("SEASON_INVALID");
  const start = ms(schedule.seasonOneStartsAt) + (season - 1) * WEEK_MS;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + WEEK_MS).toISOString(),
  };
}

/** An activity is inside the program only after activation and from season 1 onward. */
export function withinProgram(schedule: Schedule, occurredAt: string) {
  const t = ms(occurredAt);
  return t >= ms(schedule.activatedAt) && t >= ms(schedule.seasonOneStartsAt);
}

/** The owner-facing wall-clock rendering of an instant (Istanbul), e.g. "2026-11-09 00:00". */
export function istanbulWallClock(iso: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: DISPLAY_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
