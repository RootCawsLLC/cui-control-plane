-- Covered telecommunications and video surveillance manufacturers and their named affiliates,
-- as a reference table pinned to a published edition. Same pattern as the 1260H list: the
-- edition is carried so that "screened" can be distinguished from "screened against what".
select
    t.list_published_at,
    t.snapshot_ingested_at,
    t.manufacturer_name,
    t.normalised_name,
    t.aliases,
    t.covered_category
from {{ source('reference', 'covered_telecom') }} t
