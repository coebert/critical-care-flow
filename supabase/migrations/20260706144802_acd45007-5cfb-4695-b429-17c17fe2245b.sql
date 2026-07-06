-- Partial index for the hot live-referrals list query: every referrals list
-- filters `deleted_at IS NULL AND is_test = false` and orders by
-- referral_received_at DESC (usually within a status). The existing status
-- index doesn't cover the sort or the visibility filter, so the planner
-- falls back to a full scan + sort.
CREATE INDEX IF NOT EXISTS referrals_live_status_received_idx
  ON public.referrals (status, referral_received_at DESC)
  WHERE deleted_at IS NULL AND is_test = false;

-- Composite index for notification_deliveries lookups by (referral, channel,
-- status). The admin/audit views group deliveries per referral and channel;
-- without this index the audit panel does a full scan.
CREATE INDEX IF NOT EXISTS notification_deliveries_ref_channel_status_idx
  ON public.notification_deliveries (referral_id, channel, status);