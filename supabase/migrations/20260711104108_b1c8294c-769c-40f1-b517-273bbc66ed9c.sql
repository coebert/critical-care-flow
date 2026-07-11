ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS patient_initials text;
ALTER TABLE public.postop_bookings ADD COLUMN IF NOT EXISTS patient_initials text;
ALTER TABLE public.referrals ADD CONSTRAINT referrals_patient_initials_len CHECK (patient_initials IS NULL OR char_length(patient_initials) <= 10);
ALTER TABLE public.postop_bookings ADD CONSTRAINT postop_bookings_patient_initials_len CHECK (patient_initials IS NULL OR char_length(patient_initials) <= 10);