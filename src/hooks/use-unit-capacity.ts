import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPartnerBedBoard } from "@/lib/partner-bed-board.functions";
import type {
  PartnerBedBoardFailure,
  PartnerBedBoardOk,
} from "@/lib/partner-bed-board-contract";
import { getPatientAcuity, type AcuityEntry } from "@/lib/patient-acuity.functions";
import { getNurseStaffingForDate } from "@/lib/nurse-staffing.functions";
import { currentShift, type ShiftKey } from "@/lib/shift-clock";
import { purgeClinicalSnapshots, sessionScoped } from "@/lib/session-scope";
import {
  CAPACITY_REFRESH_MS,
  availableNursesFor,
  boardSourceTime,
  deriveUnitCapacity,
  freshnessOf,
  isReassuring,
  type CapacityDerivation,
  type Freshness,
  type LoadState,
} from "@/lib/unit-capacity";

/**
 * Shared query keys — every capacity surface reads the SAME cache entries so
 * a page showing the badge, mini link and callout makes one request each.
 */
export const PARTNER_BOARD_QK = ["partner-bed-board"] as const;
export const ACUITY_QK = ["patient-acuity"] as const;
export const staffingQK = (shiftDate: string) => ["nurse-staffing", shiftDate] as const;
export const STAFFING_QK_ROOT = ["nurse-staffing"] as const;

/** Thrown inside the query fn so React Query keeps the last good board. */
export class PartnerBoardUnavailableError extends Error {
  constructor(public readonly result: PartnerBedBoardFailure) {
    super(result.error);
    this.name = "PartnerBoardUnavailableError";
  }
}

const liveQueryOpts = {
  staleTime: 5_000,
  refetchInterval: CAPACITY_REFRESH_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

/** Re-render every `ms` so "x min ago" / staleness / shift boundaries update. */
export function useNow(ms = 10_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Cached board state. A denial REPLACES the cached snapshot (so nothing from
 * before a role revocation can be shown); any other failure throws so React
 * Query keeps the last good board, labelled as not current.
 */
type BoardCache = { kind: "ok"; board: PartnerBedBoardOk } | { kind: "forbidden"; failure: PartnerBedBoardFailure };

export function usePartnerBedBoard() {
  const fetchBoard = useServerFn(getPartnerBedBoard);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: PARTNER_BOARD_QK,
    queryFn: sessionScoped(async (): Promise<BoardCache> => {
      const r = await fetchBoard();
      if (r.ok) return { kind: "ok", board: r };
      if (r.forbidden) {
        // Role revoked / denied: drop every other clinical snapshot too.
        purgeClinicalSnapshots(qc, PARTNER_BOARD_QK);
        return { kind: "forbidden", failure: r };
      }
      throw new PartnerBoardUnavailableError(r);
    }),
    // The server already retries transient partner failures.
    retry: false,
    ...liveQueryOpts,
  });
  const cached = q.data;
  const forbidden = cached?.kind === "forbidden" ? cached.failure : null;
  const latestFailure: PartnerBedBoardFailure | null =
    q.status === "error"
      ? q.error instanceof PartnerBoardUnavailableError
        ? q.error.result
        : {
            ok: false,
            error: q.error instanceof Error ? q.error.message : "Could not reach the bed board service",
            fetched_at: new Date(q.errorUpdatedAt || Date.now()).toISOString(),
          }
      : forbidden;
  return {
    /** Last successfully validated board (kept through later failures, never through a denial). */
    lastOk: cached?.kind === "ok" ? cached.board : null,
    latestFailure,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    refetch: q.refetch,
  };
}

export function usePatientAcuityRows() {
  const fetchAcuity = useServerFn(getPatientAcuity);
  return useQuery({
    queryKey: ACUITY_QK,
    queryFn: sessionScoped((): Promise<AcuityEntry[]> => fetchAcuity()),
    retry: 1,
    ...liveQueryOpts,
  });
}

export function useNurseStaffingRows(shiftDate: string) {
  const fetchStaffing = useServerFn(getNurseStaffingForDate);
  return useQuery({
    queryKey: staffingQK(shiftDate),
    queryFn: sessionScoped(() => fetchStaffing({ data: { shift_date: shiftDate } })),
    retry: 1,
    ...liveQueryOpts,
  });
}

export type UnitCapacityView = {
  shift: ShiftKey;
  derivation: CapacityDerivation;
  freshness: Freshness;
  /** True only when determinate AND current — safe for green / "room to admit". */
  reassuring: boolean;
  /** Time the shown board describes (Hub `generated_at`, else fetch time). */
  lastSuccessAt: string | null;
  latestFailure: PartnerBedBoardFailure | null;
  board: PartnerBedBoardOk | null;
  isLoading: boolean;
  isFetching: boolean;
  refresh: () => void;
  now: Date;
};

function toState<T>(q: { status: string; data: T | undefined; error: unknown }): LoadState<T> {
  if (q.status === "error") return { status: "error" };
  if (q.data === undefined) return { status: "loading" };
  return { status: "ok", value: q.data };
}

/** The one hook every capacity surface uses. */
export function useUnitCapacity(): UnitCapacityView {
  const now = useNow(10_000);
  const shift = currentShift(now);
  const qc = useQueryClient();
  const board = usePartnerBedBoard();
  const acuity = usePatientAcuityRows();
  const staffing = useNurseStaffingRows(shift.date);

  const derivation = useMemo(
    () =>
      deriveUnitCapacity({
        board: board.lastOk
          ? { status: "ok", value: board.lastOk }
          : board.latestFailure
            ? { status: "error", message: board.latestFailure.error }
            : { status: "loading" },
        acuity: toState({ status: acuity.status, data: acuity.data, error: acuity.error }),
        staffing:
          staffing.status === "error"
            ? { status: "error" }
            : staffing.data === undefined
              ? { status: "loading" }
              : { status: "ok", value: availableNursesFor(staffing.data, shift.shift) },
      }),
    [board.lastOk, board.latestFailure, acuity.status, acuity.data, acuity.error, staffing.status, staffing.data, shift.shift],
  );

  // Age of the DATA (Hub snapshot time when sent), not of our last fetch.
  const lastSuccessAt = boardSourceTime(board.lastOk);
  const freshness = freshnessOf({
    lastSuccessAt,
    latestFailed: board.latestFailure !== null,
    now: now.getTime(),
  });

  return {
    shift,
    derivation,
    freshness,
    reassuring: isReassuring(derivation, freshness),
    lastSuccessAt,
    latestFailure: board.latestFailure,
    board: board.lastOk,
    isLoading: board.isLoading || acuity.isLoading || staffing.isLoading,
    isFetching: board.isFetching || acuity.isFetching || staffing.isFetching,
    refresh: () => {
      void qc.refetchQueries({ queryKey: PARTNER_BOARD_QK });
      void qc.refetchQueries({ queryKey: ACUITY_QK });
      void qc.refetchQueries({ queryKey: staffingQK(shift.date) });
    },
    now,
  };
}
