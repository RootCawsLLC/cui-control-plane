-- The CUI boundary asset population, reconciled from three sources rather than trusted from one.
--
-- `reconciliation_source` is kept on every row on purpose. An asset the CMDB knows about and the
-- cloud does not is a stale record; an asset the cloud reports and the CMDB does not is an
-- unmanaged asset, which is the finding that matters. Collapsing both to "present" would lose the
-- distinction that makes this control a Decision Support control rather than a list.
with cmdb as (
    select snapshot_at, asset_id, asset_type, owner, classification, 'cmdb' as reconciliation_source
    from {{ source('cmdb', 'assets_snapshot') }}
    where in_cui_boundary
),
cloud as (
    select snapshot_at, resource_id as asset_id, resource_type as asset_type,
           owner_tag as owner, data_classification_tag as classification,
           'aws_govcloud_config' as reconciliation_source
    from {{ source('aws_govcloud', 'config_items') }}
    where account_id in (select account_id from {{ source('enclave', 'accounts') }})
),
endpoints as (
    select snapshot_at, device_id as asset_id, 'managed-endpoint' as asset_type,
           assigned_user as owner, null as classification, 'mdm' as reconciliation_source
    from {{ source('mdm', 'devices_snapshot') }}
    where enclave_enrolled
)
select * from cmdb
union all
select * from cloud
union all
select * from endpoints
