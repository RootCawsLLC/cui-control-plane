-- control_id: ctl.scrm.procurement.telecom-equipment-attestation
--
-- population_definition (must match the where clause below):
--   Every hardware item in the asset inventory and every component in the SBOM/HBOM for systems
--   in and adjacent to the CUI boundary, resolved to a manufacturer and cross-referenced against
--   the covered-equipment list.
--
-- An unresolved manufacturer FAILS. It is not dropped from the denominator and it does not pass by
-- default - "we could not tell" is the one answer that must never be scored as "no".
with covered as (
    select normalised_name, covered_category from {{ ref('stg_covered_telecom') }}
)
select
    '{{ var("as_of") }}'::timestamp                              as as_of,
    'ctl.scrm.procurement.telecom-equipment-attestation'         as control_id,
    c.component_id                                               as subject_id,
    (c.manufacturer_resolved and cov.normalised_name is null)    as passing,
    case
        when not c.manufacturer_resolved      then 'manufacturer_unresolved'
        when cov.normalised_name is not null  then 'covered_manufacturer_' || cov.covered_category
    end                                                          as reason
from {{ ref('stg_component_inventory') }} c
left join covered cov
  on cov.normalised_name = c.manufacturer_normalised
where c.snapshot_at = '{{ var("as_of") }}'::timestamp
