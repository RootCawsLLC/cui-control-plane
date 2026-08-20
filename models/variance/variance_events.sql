-- The four variance timestamps, one row per (control_id, subject_id) variance episode.
--
-- This is the model that turns a compliance pipeline into a risk instrument. Everything upstream
-- of here satisfies an assessor; this is what produces Variance Frequency and Variance Duration,
-- which are the inputs to control reliability, which is an input to loss event frequency.
--
-- It works by walking the snapshot history of every control model. That only works because the
-- control models are appended rather than overwritten - if the landing layer overwrote, this model
-- would be empty and the whole thing would be a dashboard.
--
-- SEGMENT DECOMPOSITION - which FAIR-CAM function is slow:
--   started    -> detected   : Control Monitoring          (a cadence / coverage problem)
--   detected   -> rem_started: Treatment Sel. & Prior.     (a prioritisation / ownership problem)
--   rem_started-> completed  : Implementation              (a capacity / tooling problem)
with history as (
    select as_of, control_id, subject_id, passing
    from {{ ref('control_results_all') }}
),
transitions as (
    select
        control_id,
        subject_id,
        as_of,
        passing,
        lag(passing)  over (partition by control_id, subject_id order by as_of) as prev_passing,
        lag(as_of)    over (partition by control_id, subject_id order by as_of) as prev_as_of
    from history
),
episode_starts as (
    select
        control_id,
        subject_id,
        as_of as variance_detected_at,
        -- Option (b) from the ladder: interpolate to the previous passing snapshot, which bounds
        -- variance_started_at to the collection interval. Where a control model supplies a
        -- source-system change timestamp it overrides this downstream, and the basis is recorded
        -- either way. Option (c) - equals_detected - is never silently chosen here, because it
        -- systematically understates duration and would flatter every reliability figure derived
        -- from it.
        prev_as_of as variance_started_at_lower_bound,
        case when prev_as_of is null then 'equals_detected' else 'interpolated' end as started_at_basis
    from transitions
    where passing = false and coalesce(prev_passing, true) = true
),
episode_ends as (
    select control_id, subject_id, as_of as remediation_completed_at, prev_as_of
    from transitions
    where passing = true and prev_passing = false
)
select
    s.control_id,
    s.subject_id,
    s.variance_started_at_lower_bound          as variance_started_at,
    s.started_at_basis,
    s.variance_detected_at,
    -- remediation_started_at is not derivable from snapshot history: nothing in the config tells
    -- you when a human began acting. It is joined from the work queue where that exists and is
    -- left null otherwise, which collapses the Treatment Selection segment into Implementation
    -- and is stated rather than hidden.
    null                                       as remediation_started_at,
    e.remediation_completed_at,
    case
        when e.remediation_completed_at is null then null
        else extract(epoch from (e.remediation_completed_at - s.variance_detected_at)) / 86400.0
    end                                        as variance_duration_days_from_detection
from episode_starts s
left join episode_ends e
  on  e.control_id = s.control_id
  and e.subject_id = s.subject_id
  and e.remediation_completed_at > s.variance_detected_at
