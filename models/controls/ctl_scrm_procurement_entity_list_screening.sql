-- control_id: ctl.scrm.procurement.entity-list-screening
--
-- population_definition (must match the where clause below):
--   Every entity in the supplier master with an active or pipeline contractual relationship,
--   screened against the most recent published 1260H list snapshot and current FASC orders.
--
-- A FULL DIFF, never a sample. The list changes on a recurring cadence, so a supplier screened
-- clean last quarter is not screened now - which is why screening against a superseded edition is
-- a failure reason here and not merely a data-quality note.
with prohibited as (
    select normalised_name, 'entity_list_1260h' as authority, list_published_at as edition_at
    from {{ ref('stg_entity_list_1260h') }}
    union all
    select normalised_name, 'fasc_order' as authority, order_issued_at as edition_at
    from {{ ref('stg_fasc_orders') }}
),
current_edition as (
    select max(list_published_at) as newest_edition_at from {{ ref('stg_entity_list_1260h') }}
),
matched as (
    select
        s.supplier_id,
        s.normalised_name,
        s.parent_supplier_id,
        s.last_screened_at,
        max(p.authority) as hit_authority
    from {{ ref('stg_supplier_master') }} s
    left join prohibited p
      on p.normalised_name = s.normalised_name
    where s.snapshot_at = '{{ var("as_of") }}'::timestamp
    group by s.supplier_id, s.normalised_name, s.parent_supplier_id, s.last_screened_at
)
select
    '{{ var("as_of") }}'::timestamp                    as as_of,
    'ctl.scrm.procurement.entity-list-screening'       as control_id,
    m.supplier_id                                      as subject_id,
    (m.hit_authority is null
        and m.last_screened_at >= (select newest_edition_at from current_edition)) as passing,
    case
        when m.hit_authority = 'entity_list_1260h' then 'listed_on_1260h'
        when m.hit_authority = 'fasc_order'        then 'subject_to_fasc_order'
        when m.last_screened_at is null            then 'never_screened'
        when m.last_screened_at < (select newest_edition_at from current_edition)
            then 'screened_against_superseded_list_edition'
    end                                                as reason
from matched m
