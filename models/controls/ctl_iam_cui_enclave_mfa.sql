-- control_id: ctl.iam.cui-enclave.mfa
--
-- population_definition (must match the where clause below):
--   All human identities in the CUI enclave identity provider with status active, excluding
--   service principals and excluding break-glass accounts.
select
    '{{ var("as_of") }}'::timestamp   as as_of,
    'ctl.iam.cui-enclave.mfa'         as control_id,
    u.user_id                         as subject_id,
    (u.factor_count > 0
        and u.strongest_factor_type in ('webauthn', 'piv_cac')
        and coalesce(array_length(u.policy_exemptions, 1), 0) = 0) as passing,
    case
        when u.factor_count = 0
            then 'no_factor_enrolled'
        when u.strongest_factor_type not in ('webauthn', 'piv_cac')
            then 'no_phishing_resistant_factor'
        when coalesce(array_length(u.policy_exemptions, 1), 0) > 0
            then 'authentication_policy_exemption_active'
    end                               as reason,
    -- variance_started_at taken from the source system's own change timestamp where it exists.
    -- That is option (a), the only one that does not understate Variance Duration; the assertion
    -- record carries which option was used so a reader can discount accordingly.
    u.last_updated_at                 as variance_started_at_candidate
from {{ ref('stg_enclave_idp_users') }} u
where u.snapshot_at = '{{ var("as_of") }}'::timestamp
  and u.user_type = 'human'
  and u.status = 'active'
  and not u.is_break_glass
