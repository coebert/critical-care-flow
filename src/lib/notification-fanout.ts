// Pure, testable orchestration for fanning out notifications + web push to
// users marked "at work". The data layer and push sender are injected so this
// module can be unit-tested without a real database or network.

export interface RoleRow {
  user_id: string;
  role: string;
}

export interface ProfileRow {
  id: string;
  is_at_work: boolean;
}

export interface PushSubRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type NotificationKind = "new" | "updated" | "status" | "note";

export interface NotificationRow {
  user_id: string;
  referral_id: string;
  kind: NotificationKind;
  message: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface FanOutDeps {
  fetchEligibleRoles: (actorId: string) => Promise<RoleRow[]>;
  fetchAtWorkProfiles: (userIds: string[]) => Promise<ProfileRow[]>;
  fetchPushSubs: (userIds: string[]) => Promise<PushSubRow[]>;
  insertNotifications: (rows: NotificationRow[]) => Promise<void>;
  sendPush: (
    subs: PushSubRow[],
    payload: PushPayload,
  ) => Promise<{ goneEndpoints: string[] }>;
  deletePushSubs: (endpoints: string[]) => Promise<void>;
}

export interface FanOutArgs {
  actorId: string;
  referralId: string;
  kind: NotificationKind;
  message: string;
  url?: string;
  title?: string;
}

export interface FanOutResult {
  recipientIds: string[];
  notificationsInserted: number;
  pushSent: number;
  goneEndpointsCleared: number;
}

/**
 * Pure helper: given the eligible-role rows and the at-work profile rows,
 * return the deduped set of user IDs to notify (excluding the actor).
 *
 * The actor exclusion in the input is defensive — callers are expected to
 * already exclude the actor in their role query, but we re-filter here so
 * the invariant is impossible to violate.
 */
export function selectRecipients(
  roleRows: RoleRow[],
  atWorkProfiles: ProfileRow[],
  actorId: string,
): string[] {
  const eligible = new Set(
    roleRows.map((r) => r.user_id).filter((id) => id !== actorId),
  );
  return atWorkProfiles
    .filter((p) => p.is_at_work === true && eligible.has(p.id) && p.id !== actorId)
    .map((p) => p.id);
}

export async function fanOutNotifications(
  deps: FanOutDeps,
  args: FanOutArgs,
): Promise<FanOutResult> {
  const empty: FanOutResult = {
    recipientIds: [],
    notificationsInserted: 0,
    pushSent: 0,
    goneEndpointsCleared: 0,
  };

  const roleRows = await deps.fetchEligibleRoles(args.actorId);
  if (!roleRows.length) return empty;

  const eligibleIds = Array.from(
    new Set(roleRows.map((r) => r.user_id).filter((id) => id !== args.actorId)),
  );
  if (!eligibleIds.length) return empty;

  const atWork = await deps.fetchAtWorkProfiles(eligibleIds);
  const recipientIds = selectRecipients(roleRows, atWork, args.actorId);
  if (!recipientIds.length) return empty;

  const rows: NotificationRow[] = recipientIds.map((uid) => ({
    user_id: uid,
    referral_id: args.referralId,
    kind: args.kind,
    message: args.message,
  }));
  await deps.insertNotifications(rows);

  let pushSent = 0;
  let goneCleared = 0;
  try {
    const subs = await deps.fetchPushSubs(recipientIds);
    // Hard invariant: never send a push to a user not in the recipient set.
    const recipientSet = new Set(recipientIds);
    const safeSubs = subs.filter((s) => recipientSet.has(s.user_id));
    if (safeSubs.length) {
      const { goneEndpoints } = await deps.sendPush(safeSubs, {
        title: args.title ?? "SDH Critical Care",
        body: args.message,
        url: args.url ?? `/referrals/${args.referralId}`,
        tag: `referral-${args.referralId}`,
      });
      pushSent = safeSubs.length - goneEndpoints.length;
      if (goneEndpoints.length) {
        await deps.deletePushSubs(goneEndpoints);
        goneCleared = goneEndpoints.length;
      }
    }
  } catch (e) {
    console.error("[fanOutNotifications] push error", e);
  }

  return {
    recipientIds,
    notificationsInserted: rows.length,
    pushSent,
    goneEndpointsCleared: goneCleared,
  };
}
