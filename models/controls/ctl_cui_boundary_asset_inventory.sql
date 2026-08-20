-- control_id: ctl.cui.boundary.asset-inventory
--
-- population_definition (must match the where clause below; src/validate.mjs compares this
-- restatement against the control record and refuses drift):
--   All assets attached to the CUI enclave - hosts, storage buckets, databases, SaaS tenants and
--   managed endpoints - reconciled against the authoritative network ranges and the enclave cloud
--   account list.
--
-- This is the DENOMINATOR for every other CUI-scoped control. Denominator movement is itself the
-- alert: a drop in `total` here is not good news, it is the asset inventory failing quietly.
with reconciled as (
    select
        asset_id,
        max(asset_type)      as asset_type,
        max(owner)           as owner,
        max(classification)  as classification,
        count(distinct reconciliation_source) as source_count,
        max(case when reconciliation_source = 'cmdb' then 1 else 0 end) as in_cmdb
    from {{ ref('stg_enclave_assets') }}
    where snapshot_at = '{{ var("as_of") }}'::timestamp
    group by asset_id
)
select
    '{{ var("as_of") }}'::timestamp        as as_of,
    'ctl.cui.boundary.asset-inventory'     as control_id,
    r.asset_id                             as subject_id,
    (r.in_cmdb = 1 and r.owner is not null and r.classification is not null) as passing,
    case
        when r.in_cmdb = 0                 then 'unmanaged_asset_absent_from_cmdb'
        when r.owner is null               then 'no_owner_recorded'
        when r.classification is null      then 'no_classification_recorded'
    end                                    as reason
from reconciled r
