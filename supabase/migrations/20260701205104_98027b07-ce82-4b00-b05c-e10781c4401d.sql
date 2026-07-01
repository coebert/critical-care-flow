
CREATE TABLE public.notification_deliveries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  notification_id UUID NULL REFERENCES public.notifications(id) ON DELETE SET NULL,
  recipient_id UUID NOT NULL,
  actor_id UUID NULL,
  referral_id UUID NULL,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('inapp','push')),
  status TEXT NOT NULL CHECK (status IN ('generated','sent','failed','gone')),
  endpoint TEXT NULL,
  error TEXT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_notification_deliveries_recipient ON public.notification_deliveries(recipient_id, generated_at DESC);
CREATE INDEX idx_notification_deliveries_referral ON public.notification_deliveries(referral_id);

GRANT SELECT ON public.notification_deliveries TO authenticated;
GRANT ALL ON public.notification_deliveries TO service_role;

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recipients read own delivery records"
  ON public.notification_deliveries FOR SELECT
  TO authenticated
  USING (recipient_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));
