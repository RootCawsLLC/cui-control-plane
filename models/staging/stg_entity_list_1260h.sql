-- The published Section 1260H list, ingested as a pinned reference table.
--
-- `list_published_at` and `snapshot_ingested_at` are both kept because they answer different
-- questions: the first is which edition of the list we screened against, the second is when we
-- last looked. A supplier screened clean against a stale edition has not been screened, and only
-- carrying both makes that visible.
select
    e.list_published_at,
    e.snapshot_ingested_at,
    e.entity_name,
    e.normalised_name,
    e.aliases,
    e.parent_entity,
    e.listing_authority
from {{ source('reference', 'entity_list_1260h') }} e
