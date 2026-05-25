-- Normalize legacy sale event names left over from pre-hash naming cleanup.

UPDATE public.events
SET "type" = 'HashBought'
WHERE "type" IN ('ItemBought', 'sale');

UPDATE public.events_sepolia
SET "type" = 'HashBought'
WHERE "type" IN ('ItemBought', 'sale');
