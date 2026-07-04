ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'issue';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'enable';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'unlock';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'reissue';