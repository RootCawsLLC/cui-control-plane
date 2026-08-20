-- The supplier/subcontractor master. Built once in Phase 0 and serving BOTH the 1260H screening
-- control and the Section 889 attestation control - which is the reason it is a Phase 0
-- deliverable rather than something each control stands up for itself.
select
    s.snapshot_at,
    s.supplier_id,
    s.legal_name,
    s.normalised_name,
    s.country_of_incorporation,
    s.relationship_status,
    s.handles_cui,
    s.parent_supplier_id,
    s.last_screened_at
from {{ source('procurement', 'supplier_master') }} s
where s.relationship_status in ('active', 'pipeline')
