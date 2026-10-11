import { startOfDay, subDays } from "date-fns";
import { and, gte } from "drizzle-orm";
import { db, schema } from "./client";
import { isWorkout } from "./completed";
import { dayKey } from "./dates";
import { DEFAULT_TRAINING_LEVEL, preferences, type TrainingLevel } from "./preferences";

const { completedQuest } = schema;

export type RestSuggestion = {
  shouldRest: boolean;
  reason: "overtraining" | "consecutive_days" | "high_volume" | "deload" | "none";
  daysInARow: number;
  recentSessionCount: number;
  /** Only set by the `deload` reason: how many heavy weeks are behind this suggestion. */
  heavyWeeks?: number;
};

/**
 * Where each acute reason starts firing, read from the hero's `trainingLevel` (db/preferences.ts).
 * `regular` is the figure the app used before the setting existed, so a hero who never answered sees
 * exactly what they always did; a beginner is warned sooner, a hero who trains hard later.
 */
export type RestThresholds = {
  /** Sessions in the last 7 days for `high_volume`. */
  highVolume: number;
  /** Training days in a row for `consecutive_days`. */
  consecutiveDays: number;
  /** Sessions in the last 7 days for `overtraining`. */
  overtraining: number;
  /** Sessions in a week for it to count as heavy toward the deload rule. */
  heavyWeekSessions: number;
};

const REST_THRESHOLDS: Record<TrainingLevel, RestThresholds> = {
  beginner: { highVolume: 7, consecutiveDays: 4, overtraining: 4, heavyWeekSessions: 3 },
  regular: { highVolume: 10, consecutiveDays: 5, overtraining: 6, heavyWeekSessions: 4 },
  advanced: { highVolume: 12, consecutiveDays: 6, overtraining: 8, heavyWeekSessions: 5 },
};

/** The rest thresholds for a training level. */
export function thresholdsFor(level: TrainingLevel): RestThresholds {
  return REST_THRESHOLDS[level];
}

/**
 * Consecutive heavy weeks before an easier one is suggested. The same at every level: the deload
 * rhythm is about a month of training whoever the hero is, only "heavy" (`heavyWeekSessions`) moves.
 * Because it does not move, `REST_LOOKBACK_DAYS` is constant and needs no level to be read.
 */
const HEAVY_WEEKS_BEFORE_DELOAD = 4;

/** How far back the advice looks: the deload rule's five weeks, which cover the acute week too. */
export const REST_LOOKBACK_DAYS = (HEAVY_WEEKS_BEFORE_DELOAD + 1) * 7;

/**
 * Consecutive heavy weeks ending at `now`.
 *
 * The other rules in this file are acute — days in a row, sessions this week. None of them can
 * see fatigue accumulating across a month, which is the window the deload guidance is about
 * (docs/raw/bodyweight-app-research.md §2). This is the smallest thing that can: count back in
 * 7-day buckets and stop at the first week that was not heavy.
 */
function countHeavyWeeks(
  performedAt: readonly Date[],
  now: Date,
  heavyWeekSessions: number,
): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const perWeek = new Map<number, number>();
  for (const at of performedAt) {
    const weeksAgo = Math.floor((now.getTime() - at.getTime()) / msPerWeek);
    perWeek.set(weeksAgo, (perWeek.get(weeksAgo) ?? 0) + 1);
  }

  let heavy = 0;
  for (let weeksAgo = 0; weeksAgo <= HEAVY_WEEKS_BEFORE_DELOAD; weeksAgo++) {
    if ((perWeek.get(weeksAgo) ?? 0) < heavyWeekSessions) break;
    heavy++;
  }

  return heavy;
}

/** Training days in a row, ending on `now`'s day or the one before, from a set of day keys. */
function daysInARow(days: ReadonlySet<string>, now: Date): number {
  let cursor = startOfDay(now);
  if (!days.has(dayKey(cursor))) cursor = subDays(cursor, 1);

  let count = 0;
  while (days.has(dayKey(cursor))) {
    count++;
    cursor = subDays(cursor, 1);
  }
  return count;
}

/**
 * The rest advice for the moment `now`, from the workouts (`isWorkout`, never a walk) logged in the
 * `REST_LOOKBACK_DAYS` before it. Pure, so the reminders can ask it about every day of their
 * horizon, and so there is one rule whoever asks.
 *
 * Overtraining indicators, at the thresholds for `level` (`thresholdsFor`, `regular` by default so
 * every existing caller and test keeps the figures the app shipped with):
 * - `highVolume` or more sessions in the last 7 days (very high volume)
 * - `consecutiveDays` or more consecutive training days, ending today or yesterday
 * - `overtraining` or more sessions in the last 7 days (high volume warning)
 *
 * Days are counted with `dayKey` on both sides, never by parsing a `yyyy-MM-dd` back: JavaScript
 * reads that as UTC midnight, which west of Greenwich is the evening before, and a run of five days
 * ending yesterday counted as none there.
 */
export function restSuggestionAt(
  performedAt: readonly Date[],
  now: Date,
  level: TrainingLevel = DEFAULT_TRAINING_LEVEL,
): RestSuggestion {
  const th = thresholdsFor(level);
  const past = performedAt.filter((at) => at.getTime() <= now.getTime());
  const weekAgo = subDays(now, 7);
  const recent = past.filter((at) => at.getTime() >= weekAgo.getTime());

  if (recent.length === 0) {
    return { shouldRest: false, reason: "none", daysInARow: 0, recentSessionCount: 0 };
  }

  const consecutive = daysInARow(new Set(recent.map(dayKey)), now);
  const counts = { daysInARow: consecutive, recentSessionCount: recent.length };

  if (recent.length >= th.highVolume) return { shouldRest: true, reason: "high_volume", ...counts };
  if (consecutive >= th.consecutiveDays) {
    return { shouldRest: true, reason: "consecutive_days", ...counts };
  }
  if (recent.length >= th.overtraining) {
    return { shouldRest: true, reason: "overtraining", ...counts };
  }

  // Nothing acute — but fatigue may still be piling up across weeks.
  const heavyWeeks = countHeavyWeeks(past, now, th.heavyWeekSessions);
  if (heavyWeeks >= HEAVY_WEEKS_BEFORE_DELOAD) {
    return { shouldRest: true, reason: "deload", ...counts, heavyWeeks };
  }

  return { shouldRest: false, reason: "none", ...counts };
}

/** Today's rest advice, read from the journal at the hero's training level. */
export async function getRestSuggestion(): Promise<RestSuggestion> {
  const now = new Date();
  const [rows, level] = await Promise.all([
    db
      .select({ performedAt: completedQuest.performedAt })
      .from(completedQuest)
      // Training only. This counts days in a row and sessions per week to decide the hero is
      // overreaching, and a daily walk is the opposite of that: it read as seven hard days.
      .where(and(gte(completedQuest.performedAt, subDays(now, REST_LOOKBACK_DAYS)), isWorkout())),
    preferences.getTrainingLevel(),
  ]);

  return restSuggestionAt(
    rows.map((r) => r.performedAt),
    now,
    level ?? DEFAULT_TRAINING_LEVEL,
  );
}
