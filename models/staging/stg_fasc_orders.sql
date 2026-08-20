-- FASC exclusion and removal orders. A separate statutory authority from any NDAA section -
-- the Federal Acquisition Supply Chain Security Act - deliberately kept as its own model so the
-- authorities are never conflated in prose, then unioned into one screening control because
-- operationally they ask the same population question of the same supplier master.
select
    o.order_issued_at,
    o.snapshot_ingested_at,
    o.entity_name,
    o.normalised_name,
    o.order_type,
    o.covered_scope
from {{ source('reference', 'fasc_orders') }} o
