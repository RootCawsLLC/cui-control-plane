-- DIBNet submission receipts and DC3 malware submissions, keyed back to the incident.
select
    d.incident_id,
    d.submitted_at,
    d.accepted_at,
    d.report_control_number,
    d.dc3_malware_submitted_at
from {{ source('dibnet', 'submissions') }} d
