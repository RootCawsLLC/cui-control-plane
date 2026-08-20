-- Hardware and software components resolved to a manufacturer, from asset inventory plus
-- SBOM/HBOM. `manufacturer_resolved` is the field that matters: an unresolved manufacturer is a
-- variance, not an absence of one.
select
    c.snapshot_at,
    c.component_id,
    c.parent_asset_id,
    c.component_type,
    c.manufacturer_raw,
    c.manufacturer_normalised,
    c.manufacturer_resolved,
    c.is_substantial_or_essential,
    c.source_of_record
from {{ source('inventory', 'components') }} c
