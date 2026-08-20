-- control_id: ctl.iam.corp-it.mfa
--
-- population_definition (must match the where clause below):
--   All human identities in the corporate identity provider with status active, excluding
--   service principals. Explicitly excludes enclave identities.
--
-- Out of the CMMC assessment boundary by design. It runs anyway because the business carries the
-- risk regardless of who scores it - and keeping it separate is what stops a corporate-IT failure
-- from costing points in an SPRS score it has no business affecting.
select
    '{{ var("as_of") }}'::timestamp   as as_of,
    'ctl.iam.corp-it.mfa'             as control_id,
    u.user_id                         as subject_id,
    (u.factor_count > 0 and not u.conditional_access_exempt) as passing,
    case
        when u.factor_count = 0          then 'no_factor_enrolled'
        when u.conditional_access_exempt then 'conditional_access_exception_active'
    end                               as reason
from {{ ref('stg_corp_idp_users') }} u
where u.snapshot_at = '{{ var("as_of") }}'::timestamp
  and u.user_type = 'human'
  and u.status = 'active'
