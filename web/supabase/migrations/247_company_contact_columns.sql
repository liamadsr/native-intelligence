-- 247: company contact columns
--
-- The Exa CONTACT card (src/lib/exa/deep-search.ts COMPANY_CARD_CONTACT) reads
-- the company's own contact page and fills these two alongside the existing
-- `address`. Both are plain editable properties in the company panel and get
-- the same fill-empty write-back as every other enriched column.
ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS contact_email text;
