
-- Radnor CCU is a single unit of 10 beds; first two are side rooms.
DELETE FROM public.beds WHERE unit = 'hdu';

UPDATE public.beds SET is_side_room = true  WHERE code IN ('ICU-1','ICU-2');
UPDATE public.beds SET is_side_room = false WHERE code IN ('ICU-5','ICU-6');
