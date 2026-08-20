-- Incident records, including those triaged as NOT reportable.
--
-- Non-reportable incidents stay in the population with their classification and its basis. That
-- is the judgement most worth being able to review later; filtering them out here would make a
-- misclassification invisible to the control that exists to catch it.
select
    i.incident_id,
    i.opened_at,
    i.discovered_at,
    i.occurred_at,
    i.occurred_at_basis,
    i.triage_started_at,
    i.affects_covered_contractor_system,
    i.affects_cui,
    i.reportable_classification,
    i.classification_basis,
    i.system_image_preserved_until,
    i.malware_isolated
from {{ source('ir', 'incidents') }} i
