import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { differenceInCalendarDays, endOfDay, startOfDay } from "date-fns";

import { getPostopAnalytics } from "@/lib/analytics.functions";
import {
  buildArrivalBuckets,
  buildByLevel,
  buildBySex,
  buildPerDay,
  buildPerDayByLevel,
  collectArrivalDelays,
  makeDayKeys,
  meanOf,
  summariseArrivalDelays,
  type PostopBookingRow,
} from "@/lib/postop-analytics-utils";

/**
 * Data + memoised derivations for the post-op analytics panel. The panel
 * component only owns the date range and drill-down UI state; every chart
 * dataset and summary statistic is prepared here so the component stays
 * declarative.
 */
export function usePostopAnalytics(from: Date, to: Date) {
  const listFn = useServerFn(getPostopAnalytics);

  const clampedFrom = startOfDay(from);
  const clampedTo = endOfDay(to);
  const days = Math.max(1, differenceInCalendarDays(clampedTo, clampedFrom) + 1);
  const fromIso = clampedFrom.toISOString();
  const toIso = clampedTo.toISOString();

  const { data: bookings = [] } = useQuery({
    queryKey: ["postop-analytics", fromIso, toIso],
    queryFn: () => listFn({ data: { from: fromIso, to: toIso } }),
  });

  const filtered = useMemo<PostopBookingRow[]>(
    () =>
      (bookings as PostopBookingRow[]).filter((b) => {
        const t = new Date(b.created_at).getTime();
        return t >= clampedFrom.getTime() && t <= clampedTo.getTime();
      }),
    [bookings, clampedFrom, clampedTo],
  );

  const dayKeys = useMemo(() => makeDayKeys(clampedFrom, clampedTo), [clampedFrom, clampedTo]);
  const perDay = useMemo(() => buildPerDay(filtered, dayKeys), [filtered, dayKeys]);
  const perDayByLevel = useMemo(() => buildPerDayByLevel(filtered, dayKeys), [filtered, dayKeys]);
  const byLevel = useMemo(() => buildByLevel(filtered), [filtered]);
  const bySex = useMemo(() => buildBySex(filtered), [filtered]);

  const meanAge = useMemo(
    () => meanOf(filtered.map((b) => b.age).filter((x): x is number => x != null)),
    [filtered],
  );
  const meanBmi = useMemo(
    () =>
      meanOf(
        filtered
          .map((b) => (b.bmi != null ? Number(b.bmi) : null))
          .filter((x): x is number => x != null && !Number.isNaN(x)),
      ),
    [filtered],
  );

  const arrivalDelays = useMemo(() => collectArrivalDelays(filtered), [filtered]);
  const arrivalStats = useMemo(() => summariseArrivalDelays(arrivalDelays), [arrivalDelays]);
  const arrivalBuckets = useMemo(() => buildArrivalBuckets(arrivalDelays), [arrivalDelays]);

  const meanPerWeek = (filtered.length / Math.max(days, 1)) * 7;

  return {
    from: clampedFrom,
    to: clampedTo,
    days,
    filtered,
    perDay,
    perDayByLevel,
    byLevel,
    bySex,
    meanAge,
    meanBmi,
    meanPerWeek,
    arrivalStats,
    arrivalBuckets,
  };
}

export type PostopAnalyticsData = ReturnType<typeof usePostopAnalytics>;
