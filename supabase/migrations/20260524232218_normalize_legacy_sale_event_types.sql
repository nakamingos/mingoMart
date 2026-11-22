-- Normalize legacy external market event names left over from pre-hash naming cleanup.

UPDATE public.events
SET "type" = CASE "type"
  WHEN 'ItemBought' THEN 'HashBought'
  WHEN 'sale' THEN 'HashBought'
  WHEN 'ItemOffered' THEN 'HashOffered'
  WHEN 'offered' THEN 'HashOffered'
  WHEN 'ItemListed' THEN 'HashOffered'
  WHEN 'listed' THEN 'HashOffered'
  ELSE "type"
END
WHERE "type" IN ('ItemBought', 'sale', 'ItemOffered', 'offered', 'ItemListed', 'listed');

UPDATE public.events_sepolia
SET "type" = CASE "type"
  WHEN 'ItemBought' THEN 'HashBought'
  WHEN 'sale' THEN 'HashBought'
  WHEN 'ItemOffered' THEN 'HashOffered'
  WHEN 'offered' THEN 'HashOffered'
  WHEN 'ItemListed' THEN 'HashOffered'
  WHEN 'listed' THEN 'HashOffered'
  ELSE "type"
END
WHERE "type" IN ('ItemBought', 'sale', 'ItemOffered', 'offered', 'ItemListed', 'listed');
