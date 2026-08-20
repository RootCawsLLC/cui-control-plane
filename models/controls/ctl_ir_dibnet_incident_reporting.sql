-- control_id: ctl.ir.dibnet.incident-reporting
--
-- population_definition (must match the where clause below):
--   Every incident record classified as a cyber incident affecting a covered contractor
--   information system or the CUI it holds, within the reporting window. Incidents triaged as
--   non-reportable REMAIN in the population with their classification and its basis.
--
-- Event-triggered, not continuously sampled: this model can legitimately return zero rows, and a
-- zero-row assertion is a pass over an empty population rather than a missing measurement. The
-- assertion record says total: 0 and means it.
--
-- The 72-hour clock runs from DISCOVERY, per the clause - not from occurrence. The elapsed test is
-- therefore computed from discovered_at, and occurred_at is carried separately so that any report
-- showing the shorter window can say which window it is showing.
select
    '{{ var("as_of") }}'::timestamp        as as_of,
    'ctl.ir.dibnet.incident-reporting'     as control_id,
    i.incident_id                          as subject_id,
    (d.accepted_at is not null
        and extract(epoch from (d.accepted_at - i.discovered_at)) / 3600.0 <= 72
        and i.system_image_preserved_until >= i.discovered_at + interval '90 days'
        and (not i.malware_isolated or d.dc3_malware_submitted_at is not null)) as passing,
    case
        when d.accepted_at is null
            then 'no_dibnet_submission'
        when extract(epoch from (d.accepted_at - i.discovered_at)) / 3600.0 > 72
            then 'submitted_after_72h_from_discovery'
        when i.system_image_preserved_until < i.discovered_at + interval '90 days'
            then 'image_preservation_short_of_90_days'
        when i.malware_isolated and d.dc3_malware_submitted_at is null
            then 'isolated_malware_not_submitted_to_dc3'
    end                                    as reason,
    i.occurred_at                          as variance_started_at_candidate,
    i.occurred_at_basis                    as started_at_basis,
    i.discovered_at                        as variance_detected_at,
    i.triage_started_at                    as remediation_started_at,
    d.accepted_at                          as remediation_completed_at
from {{ ref('stg_incidents') }} i
left join {{ ref('stg_dibnet_submissions') }} d
  on d.incident_id = i.incident_id
where i.affects_covered_contractor_system or i.affects_cui
