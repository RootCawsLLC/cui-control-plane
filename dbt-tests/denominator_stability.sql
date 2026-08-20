-- Denominator stability, across consecutive snapshots of every control.
--
-- `total` is not a byproduct of a control test, it IS a control metric. If the population moves
-- without explanation then the asset inventory - a Decision Support Control - failed BEFORE the
-- control that appears to have failed downstream. So this alerts on denominator movement, not
-- just on failures.
--
-- This replaced a `dbt_utils.equal_rowcount` test that compared the asset-inventory model to
-- itself. It passed every run because a set always equals itself, and it was severity: warn as
-- well, so it could not have failed the build even if the comparison had been meaningful.
--
-- A singular test rather than a generic one because the interesting comparison is between two
-- rows of history, not between two models. It returns the offending (control_id, as_of) pairs;
-- dbt fails the test when it returns any rows.
--
-- The threshold is a documented convention, not an empirical result: tune it per control once
-- there is enough history to know what normal churn looks like. Until then 10% is a starting
-- point chosen to be noisy rather than quiet, because a missed denominator shift is the failure
-- mode that hides every other failure.

{% set threshold = 0.10 %}

with counts as (
    select
        control_id,
        as_of,
        count(*) as total
    from {{ ref('control_results_all') }}
    group by control_id, as_of
),
compared as (
    select
        control_id,
        as_of,
        total,
        lag(total)  over (partition by control_id order by as_of) as prev_total,
        lag(as_of)  over (partition by control_id order by as_of) as prev_as_of
    from counts
)
select
    control_id,
    prev_as_of,
    as_of,
    prev_total,
    total,
    abs(total - prev_total) * 1.0 / nullif(prev_total, 0) as movement
from compared
where prev_total is not null
  -- A denominator that drops to zero is always a finding, even under the threshold: it means the
  -- population query stopped returning anything, which reads as "nothing is failing" downstream.
  and (total = 0 or abs(total - prev_total) * 1.0 / nullif(prev_total, 0) > {{ threshold }})
