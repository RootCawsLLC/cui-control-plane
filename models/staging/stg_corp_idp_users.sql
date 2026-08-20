-- Identities in the corporate IdP tenant. Separate source, separate model, separate control -
-- see the split_rationale on ctl.iam.corp-it.mfa.
select
    s.snapshot_at,
    s.user_id,
    s.login,
    s.status,
    s.user_type,
    s.factor_count,
    s.conditional_access_exempt,
    s.last_updated_at
from {{ source('corp_idp', 'users_snapshot') }} s
