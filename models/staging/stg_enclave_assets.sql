-- The CUI boundary asset population, reconciled from three sources rather than trusted from one.
--
-- `reconciliation_source` is kept on every row on purpose. An asset the CMDB knows about and the
-- cloud does not is a stale record; an asset the cloud reports and the CMDB does not is an
-- unmanaged asset, which is the finding that matters. Collapsing both to "present" would lose the
-- distinction that makes this control a Decision Support control rather than a list.
--
-- PROVIDER-NEUTRAL BY DESIGN. The cloud half reads one table that any cloud collector populates -
-- Azure Resource Graph today, AWS Config or a CSV export tomorrow. This SQL does not know which,
-- so adding a provider is a new collector rather than a fork of this model.
--
-- The enclave boundary comes from ccp.config.yaml and is applied by the collector, which queries
-- only the declared subscriptions. It is deliberately NOT a filter here: a boundary defined as
-- "whatever the credential could reach" expands silently every time somebody is granted access.
with cmdb as (
    select
        snapshot_at,
        asset_id,
        asset_type,
        owner,
        classification,
        'cmdb' as reconciliation_source
    from {{ source('cmdb', 'assets_snapshot') }}
    where coalesce(in_cui_boundary, true)
),
cloud as (
    select
        snapshot_at,
        resource_id as asset_id,
        resource_type as asset_type,
        owner_tag as owner,
        data_classification_tag as classification,
        'cloud' as reconciliation_source
    from {{ source('cloud', 'resources') }}
),
endpoints as (
    select
        snapshot_at,
        device_id as asset_id,
        'managed-endpoint' as asset_type,
        assigned_user as owner,
        cast(null as varchar) as classification,
        'mdm' as reconciliation_source
    from {{ source('mdm', 'devices_snapshot') }}
    where coalesce(enclave_enrolled, false)
)
select * from cmdb
union all
select * from cloud
union all
select * from endpoints
