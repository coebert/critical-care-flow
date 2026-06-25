CREATE TYPE public.admission_urgency AS ENUM ('within_15_min','within_30_min','within_1_hour','within_1_2_hours');
ALTER TABLE public.referrals ADD COLUMN admission_urgency public.admission_urgency;