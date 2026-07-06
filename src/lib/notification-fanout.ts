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
  notify_notes?: boolean;
  notify_status?: boolean;
  notify_new_referral?: boolean;
  notify_updated_referral?: boolean;
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

export interface PushDeliveryResult {
  endpoint: string;
  user_id: string;
  ok: boolean;
  gone?: boolean;
  error?: string;
}

export interface DeliveryAuditRow {
  notification_id: string | null;
  recipient_id: string;
  actor_id: string;
  referral_id: string;
  kind: NotificationKind;
  channel: "inapp" | "push";
  status: "generated" | "sent" | "failed" | "gone";
  endpoint: string | null;
  error: string | null;
  delivered_at: string | null;
}

export interface FanOutDeps {
  fetchEligibleRoles: (actorId: string) => Promise<RoleRow[]>;
  fetchAtWorkProfiles: (userIds: string[]) => Promise<ProfileRow[]>;
  fetchPushSubs: (userIds: string[]) => Promise<PushSubRow[]>;
  // May return void (legacy) or the inserted rows for delivery-audit linking.
  insertNotifications: (
    rows: NotificationRow[],
  ) => Promise<void | Array<{ id: string; user_id: string }>>;
  sendPush: (
    subs: PushSubRow[],
    payload: PushPayload,
  ) => Promise<{ goneEndpoints: string[]; results?: PushDeliveryResult[] }>;
  deletePushSubs: (endpoints: string[]) => Promise<void>;
  recordDeliveries?: (rows: DeliveryAuditRow[]) => Promise<void>;
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
  deliveriesRecorded: number;
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
  kind?: NotificationKind,
): string[] {
  const eligible = new Set(
    roleRows.map((r) => r.user_id).filter((id) => id !== actorId),
  );
  return atWorkProfiles
    .filter((p) => {
      if (!p.is_at_work) return false;
      if (!eligible.has(p.id) || p.id === actorId) return false;
      if (kind === "note" && p.notify_notes === false) return false;
      if (kind === "status" && p.notify_status === false) return false;
      return true;
    })
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
    deliveriesRecorded: 0,
  };

  const roleRows = await deps.fetchEligibleRoles(args.actorId);
  if (!roleRows.length) return empty;

  const eligibleIds = Array.from(
    new Set(roleRows.map((r) => r.user_id).filter((id) => id !== args.actorId)),
  );
  if (!eligibleIds.length) return empty;

  const atWork = await deps.fetchAtWorkProfiles(eligibleIds);
  const recipientIds = selectRecipients(roleRows, atWork, args.actorId, args.kind);
  if (!recipientIds.length) return empty;

  const rows: NotificationRow[] = recipientIds.map((uid) => ({
    user_id: uid,
    referral_id: args.referralId,
    kind: args.kind,
    message: args.message,
  }));
  const inserted = await deps.insertNotifications(rows);
  const notifIdByUser = new Map<string, string>();
  if (Array.isArray(inserted)) {
    for (const r of inserted) notifIdByUser.set(r.user_id, r.id);
  }

  const auditRows: DeliveryAuditRow[] = recipientIds.map((uid) => ({
    notification_id: notifIdByUser.get(uid) ?? null,
    recipient_id: uid,
    actor_id: args.actorId,
    referral_id: args.referralId,
    kind: args.kind,
    channel: "inapp",
    status: "generated",
    endpoint: null,
    error: null,
    delivered_at: new Date().toISOString(),
  }));

  let pushSent = 0;
  let goneCleared = 0;
  try {
    const subs = await deps.fetchPushSubs(recipientIds);
    // Hard invariant: never send a push to a user not in the recipient set.
    const recipientSet = new Set(recipientIds);
    const safeSubs = subs.filter((s) => recipientSet.has(s.user_id));
    if (safeSubs.length) {
      const { goneEndpoints, results } = await deps.sendPush(safeSubs, {
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
      const gone = new Set(goneEndpoints);
      const now = new Date().toISOString();
      if (results && results.length) {
        for (const r of results) {
          auditRows.push({
            notification_id: notifIdByUser.get(r.user_id) ?? null,
            recipient_id: r.user_id,
            actor_id: args.actorId,
            referral_id: args.referralId,
            kind: args.kind,
            channel: "push",
            status: r.gone ? "gone" : r.ok ? "sent" : "failed",
            endpoint: r.endpoint,
            error: r.error ?? null,
            delivered_at: now,
          });
        }
      } else {
        // Fallback when sendPush didn't return per-endpoint results.
        for (const s of safeSubs) {
          auditRows.push({
            notification_id: notifIdByUser.get(s.user_id) ?? null,
            recipient_id: s.user_id,
            actor_id: args.actorId,
            referral_id: args.referralId,
            kind: args.kind,
            channel: "push",
            status: gone.has(s.endpoint) ? "gone" : "sent",
            endpoint: s.endpoint,
            error: null,
            delivered_at: now,
          });
        }
      }
    }
  } catch (e) {
    console.error("[fanOutNotifications] push error", e);
    const now = new Date().toISOString();
    for (const uid of recipientIds) {
      auditRows.push({
        notification_id: notifIdByUser.get(uid) ?? null,
        recipient_id: uid,
        actor_id: args.actorId,
        referral_id: args.referralId,
        kind: args.kind,
        channel: "push",
        status: "failed",
        endpoint: null,
        error: e instanceof Error ? e.message : String(e),
        delivered_at: now,
      });
    }
  }

  let deliveriesRecorded = 0;
  if (deps.recordDeliveries && auditRows.length) {
    try {
      await deps.recordDeliveries(auditRows);
      deliveriesRecorded = auditRows.length;
    } catch (e) {
      console.error("[fanOutNotifications] delivery audit error", e);
    }
  }

  return {
    recipientIds,
    notificationsInserted: rows.length,
    pushSent,
    goneEndpointsCleared: goneCleared,
    deliveriesRecorded,
  };
}
