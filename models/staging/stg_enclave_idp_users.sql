-- Identities in the CUI enclave IdP tenant, one row per identity per snapshot.
--
-- The human-versus-service split happens HERE and not in the control model, because it is the
-- part an assessor will argue with and it should be one definition that every enclave identity
-- control inherits rather than a where clause each of them re-invents slightly differently.
select
    s.snapshot_at,
    s.user_id,
    s.login,
    s.status,
    s.user_type,
    s.factor_count,
    s.strongest_factor_type,
    s.policy_exemptions,
    -- Break-glass accounts are excluded from the MFA population by the control model and carry
    -- their own control. They are identified by an attribute on the account, never by a name
    -- pattern: a naming convention is not an access control and matching on one would mean the
    -- population silently changes whenever somebody renames an account.
    s.is_break_glass,
    s.created_at,
    s.last_updated_at
from {{ source('enclave_idp', 'users_snapshot') }} s
