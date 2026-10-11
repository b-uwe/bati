/**
 * @jest-environment ./__tests__/helpers/timezoneEnvironment.js
 * @jest-environment-options {"timezone": "America/New_York"}
 */
import { restSuggestionAt, thresholdsFor } from "@/db/restSuggestions";

// Pure: nothing here touches the database, but the module that holds it does at import.
jest.mock("@/db/client", () => ({ db: {}, schema: jest.requireActual("@/db/schema") }));

/**
 * The pure half of the rest advice, which the reminders ask about every day of their horizon.
 *
 * West of UTC on purpose. `getRestSuggestion` used to rebuild each training day with
 * `new Date("yyyy-MM-dd")`, which JavaScript reads as UTC midnight: in New York that is the evening
 * before, so a hero whose last session was *yesterday* read as training the day before that, the
 * "today or yesterday" gate failed, and five days in a row counted as none.
 */

/** Noon `daysAgo` days before `now`, local. */
function sessionsOn(now: Date, ...daysAgo: number[]): Date[] {
  return daysAgo.map((d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, 12));
}

const now = new Date(2026, 0, 15, 20, 0);

describe("restSuggestionAt", () => {
  test("runs in UTC-5, so the bug below can show", () => {
    expect(now.getTimezoneOffset()).toBe(300);
  });

  test("five days in a row ending yesterday still count, west of UTC", () => {
    const result = restSuggestionAt(sessionsOn(now, 1, 2, 3, 4, 5), now);
    expect(result.reason).toBe("consecutive_days");
    expect(result.daysInARow).toBe(5);
  });

  test("five days in a row ending today", () => {
    expect(restSuggestionAt(sessionsOn(now, 0, 1, 2, 3, 4), now).reason).toBe("consecutive_days");
  });

  test("the run expires two days after it ends", () => {
    const sessions = sessionsOn(now, 0, 1, 2, 3, 4);
    const inTwoDays = new Date(2026, 0, 17, 20, 0);
    expect(restSuggestionAt(sessions, new Date(2026, 0, 16, 20, 0)).reason).toBe(
      "consecutive_days",
    );
    expect(restSuggestionAt(sessions, inTwoDays).daysInARow).toBe(0);
  });

  test("sessions after `now` are not seen: a day is judged on what came before it", () => {
    const earlier = new Date(2026, 0, 10, 20, 0);
    expect(restSuggestionAt(sessionsOn(now, 0, 1, 2, 3, 4), earlier).recentSessionCount).toBe(0);
  });

  test("ten sessions in a week is high volume, six is overtraining", () => {
    expect(restSuggestionAt(sessionsOn(now, 0, 0, 1, 1, 2, 2, 4, 4, 6, 6), now).reason).toBe(
      "high_volume",
    );
    expect(restSuggestionAt(sessionsOn(now, 0, 1, 2, 3, 5, 6), now).reason).toBe("overtraining");
  });

  test("four heavy weeks earn a deload, and it still says shouldRest", () => {
    const days = [0, 1, 2, 3].flatMap((w) => [1, 2, 4, 6].map((o) => w * 7 + o));
    const result = restSuggestionAt(sessionsOn(now, ...days), now);
    expect(result.reason).toBe("deload");
    expect(result.shouldRest).toBe(true);
  });

  test("nothing logged, nothing advised", () => {
    expect(restSuggestionAt([], now)).toEqual({
      shouldRest: false,
      reason: "none",
      daysInARow: 0,
      recentSessionCount: 0,
    });
  });

  test("the default level is regular, so an unchanged caller sees the figures the app shipped with", () => {
    const sessions = sessionsOn(now, 0, 1, 2, 3);
    expect(restSuggestionAt(sessions, now)).toEqual(restSuggestionAt(sessions, now, "regular"));
  });
});

describe("restSuggestionAt: training level moves the thresholds", () => {
  test("four days in a row rests a beginner, where regular waits for five", () => {
    const fourInARow = sessionsOn(now, 0, 1, 2, 3);
    expect(restSuggestionAt(fourInARow, now, "beginner").reason).toBe("consecutive_days");
    expect(restSuggestionAt(fourInARow, now, "regular").reason).toBe("none");
    expect(restSuggestionAt(fourInARow, now, "advanced").reason).toBe("none");
  });

  test("six sessions in a week is overtraining for regular, nothing for advanced", () => {
    // Five training days, two of them on the same day, so the run ending today stays short.
    const sixSpread = sessionsOn(now, 0, 0, 1, 3, 4, 6);
    expect(restSuggestionAt(sixSpread, now, "regular").reason).toBe("overtraining");
    expect(restSuggestionAt(sixSpread, now, "advanced").reason).toBe("none");
  });

  test("a beginner's week of four weeks earns a deload where regular's four do not", () => {
    // Three sessions a week: a heavy week for a beginner (3), a light one for regular (needs 4).
    const days = [0, 1, 2, 3].flatMap((w) => [1, 3, 5].map((o) => w * 7 + o));
    expect(restSuggestionAt(sessionsOn(now, ...days), now, "beginner").reason).toBe("deload");
    expect(restSuggestionAt(sessionsOn(now, ...days), now, "regular").reason).toBe("none");
  });

  test("thresholdsFor returns each level's table", () => {
    expect(thresholdsFor("beginner")).toEqual({
      highVolume: 7,
      consecutiveDays: 4,
      overtraining: 4,
      heavyWeekSessions: 3,
    });
    expect(thresholdsFor("regular")).toEqual({
      highVolume: 10,
      consecutiveDays: 5,
      overtraining: 6,
      heavyWeekSessions: 4,
    });
    expect(thresholdsFor("advanced")).toEqual({
      highVolume: 12,
      consecutiveDays: 6,
      overtraining: 8,
      heavyWeekSessions: 5,
    });
  });
});
