'use client';

import { useState } from 'react';

/* ---- light client-side mirrors of the tool's shapes (only fields we render) ---- */
interface Edge { framework: string; reference: string; confidence: string; basis: string; }
interface Control {
  control_id: string;
  title: string;
  status: string;
  layer: string;
  owner: string;
  assertion: string;
  population_definition: string;
  split_rationale: string | null;
  faircam: { function: string; primary: boolean }[];
  crosswalk: Edge[];
}
interface Regime {
  key: string;
  name: string;
  driver: string;
  rule: string;
  demands: string;
  edges: { control_id: string; reference: string; confidence: string }[];
  edge_count: number;
  control_count: number;
}
interface CoverageRow { id: string; family: string; state: string; controls: string[]; }
interface Coverage {
  requirement_count: number;
  operating: number; intended: number; weak: number; uncovered: number;
  mapped: CoverageRow[];
}
interface Sprs {
  computed: boolean; refused?: boolean; message?: string; weightsPath: string;
  score?: number; basis?: number; deduction?: number; met?: number; unmet?: number;
  at_or_above_conditional_threshold?: boolean;
  weights_verified?: boolean; evidence_is_fixture?: boolean; submittable?: boolean;
  stateCounts?: Record<string, number>;
}
interface VarianceRow {
  control_id: string; title: string; snapshots: number; window_days: number | null;
  episodes: number; closed: number; censored: number;
  variance_frequency_per_year: number | null; variance_duration_days: number | null;
  extrapolated: boolean; saturated: boolean; understated_episodes: number; sla_hours: number | null;
}
interface LatestAssertion {
  control_id: string; as_of: string; total: number | null; passing_count: number | null;
  failing_count: number | null; failing_enumerated: number | null; query_ref: string | null; fixture: boolean;
}
interface OscalFile { name: string; model: string; bytes: number; preview: string; }
interface Result {
  toolVersion: string; node: string; fixtureStamp: string; isFixture: boolean;
  assertionsDir: string; controlCount: number; crosswalkEdges: number;
  inventory: Control[]; regimes: Regime[]; latestAssertions: LatestAssertion[];
  coverage?: Coverage; sprs?: Sprs; variance?: { rows: VarianceRow[] };
  oscal?: { files: OscalFile[]; count: number };
  durationMs: number;
}

export default function Page() {
  const [coverage, setCoverage] = useState(true);
  const [sprs, setSprs] = useState(true);
  const [variance, setVariance] = useState(true);
  const [oscal, setOscal] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sections: { coverage, sprs, variance, oscal } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Run failed.');
      setResult(data as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1>cui-control-plane</h1>
      <p className="thesis">
        <b>One</b> control inventory for a DoD CUI boundary. The five NDAA-driven regimes attach to it
        as <b>crosswalk edges</b> — not as five parallel compliance programs. The same pipeline that
        produces the assessment package also derives the <b>SPRS score</b> from assertion records and
        emits the <b>OSCAL O1–O5</b> package with deterministic UUIDs.
      </p>
      <p className="sub">
        <a href="https://github.com/RootCawsLLC/cui-control-plane">Source</a> · This runs the{' '}
        <b>real tool</b> out-of-process against the bundled synthetic fixtures. It contacts no real
        system and uses no credentials — by design.
      </p>

      <div className="callout">
        Click <b>Run</b> to execute <code>ccp coverage</code>, <code>ccp sprs</code>,{' '}
        <code>ccp variance</code> and <code>ccp emit all</code> against the stamped{' '}
        <span className="stamp">NOT REAL EVIDENCE</span> fixture assertions. Everything below is the
        tool&apos;s own output — nothing is a recording, and the SPRS scorer refuses to call a
        fixture-derived number submittable.
      </div>

      <div className="panel">
        <div className="sections">
          {[
            ['Coverage', coverage, setCoverage, 'of the 110 requirements'],
            ['SPRS score', sprs, setSprs, 'derived from assertions'],
            ['Variance', variance, setVariance, 'VF/VD — the risk half'],
            ['OSCAL O1–O5', oscal, setOscal, 'emit the package'],
          ].map(([label, val, set, hint]) => (
            <label className="section-tog" key={label as string}>
              <input
                type="checkbox"
                checked={val as boolean}
                onChange={(e) => (set as (v: boolean) => void)(e.target.checked)}
              />
              <span>
                <span className="lt">{label as string}</span>{' '}
                <span className="notes">— {hint as string}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="run-row">
          <button className="run" onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run the control plane'}
          </button>
          {running && (
            <span className="notes">
              <span className="spinner" /> Spawning a clean Node process that imports the tool and
              emits the OSCAL package…
            </span>
          )}
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      {result && <Results r={result} />}
    </>
  );
}

function Results({ r }: { r: Result }) {
  return (
    <>
      <h2>Result <span className="h2note">— tool v{r.toolVersion}, {r.node}, {(r.durationMs / 1000).toFixed(2)}s</span></h2>
      <div className="panel">
        <div className="summary">
          <span><b>{r.controlCount}</b><br />controls</span>
          <span><b>{r.crosswalkEdges}</b><br />crosswalk edges</span>
          {r.coverage && <span><b>{r.coverage.requirement_count}</b><br />requirements</span>}
          {r.sprs?.computed && <span><b>{r.sprs.score}</b><br />SPRS of {r.sprs.basis}</span>}
          {r.oscal && <span><b>{r.oscal.count}</b><br />OSCAL artifacts</span>}
          <span style={{ alignSelf: 'center' }}><span className="stamp">{r.fixtureStamp}</span></span>
        </div>
      </div>

      <Regimes regimes={r.regimes} />
      <Inventory inventory={r.inventory} />
      {r.coverage && <CoverageView c={r.coverage} />}
      {r.sprs && <SprsView s={r.sprs} latest={r.latestAssertions} />}
      {r.variance && <VarianceView rows={r.variance.rows} />}
      {r.oscal && <OscalView files={r.oscal.files} />}
    </>
  );
}

function Regimes({ regimes }: { regimes: Regime[] }) {
  return (
    <>
      <h2>The framing <span className="h2note">— five NDAA regimes as crosswalk edges into one inventory</span></h2>
      <div className="regimes">
        {regimes.map((rg) => (
          <div className={`regime ${rg.edge_count === 0 ? 'empty' : ''}`} key={rg.key}>
            <div className="rn">{rg.name}</div>
            <div className="rd">{rg.driver} · {rg.rule}</div>
            <div className="rdem">{rg.demands}</div>
            {rg.edge_count > 0 ? (
              <>
                <div className="notes" style={{ marginBottom: '0.3rem' }}>
                  {rg.edge_count} crosswalk edge{rg.edge_count === 1 ? '' : 's'} from {rg.control_count} control
                  {rg.control_count === 1 ? '' : 's'}:
                </div>
                <div className="redges">
                  {rg.edges.map((e, i) => (
                    <span className={`edge ${e.confidence === 'low' ? 'low' : ''}`} key={i}>
                      {e.reference} <span className="cf">({e.confidence})</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="none">No edge yet — anticipated, crosswalk-ready. Not front-run.</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const statusClass = (s: string) => `st-${s}`;

function Inventory({ inventory }: { inventory: Control[] }) {
  return (
    <>
      <h2>The control inventory <span className="h2note">— one YAML record per control; frameworks are edges, not columns</span></h2>
      {inventory.map((c) => (
        <div className="control" key={c.control_id}>
          <div className="c-head">
            <span className="c-id">{c.control_id}</span>
            <span className={`badge ${statusClass(c.status)}`}>{c.status}</span>
            <span className="badge layer">{c.layer}</span>
          </div>
          <div className="c-title">{c.title}</div>
          <div className="c-assert">{c.assertion}</div>
          <div className="c-meta">
            owner: {c.owner}
            {c.faircam.length > 0 && <> · FAIR-CAM: {c.faircam.map((f) => `${f.function}${f.primary ? '*' : ''}`).join(', ')}</>}
          </div>
          <div className="c-xw">
            {c.crosswalk.map((e, i) => (
              <span className={`edge ${e.confidence === 'low' ? 'low' : ''}`} key={i}>
                {e.framework} {e.reference} <span className="cf">({e.confidence})</span>
              </span>
            ))}
          </div>
          <details className="detail">
            <summary>Population &amp; crosswalk basis</summary>
            <div className="body">
              <span className="lbl">Population definition</span>
              {c.population_definition}
              {c.split_rationale && (
                <>
                  <span className="lbl">Layer split rationale</span>
                  {c.split_rationale}
                </>
              )}
              {c.crosswalk.map((e, i) => (
                <div key={i}>
                  <span className="lbl">{e.framework} {e.reference} — {e.confidence}</span>
                  {e.basis}
                </div>
              ))}
            </div>
          </details>
        </div>
      ))}
    </>
  );
}

function CoverageView({ c }: { c: Coverage }) {
  const total = c.requirement_count;
  const seg = (n: number) => ({ flex: n === 0 ? 0 : n, minWidth: n === 0 ? 0 : undefined });
  return (
    <>
      <h2>Coverage <span className="h2note">— NIST SP 800-171 Rev 2, {total} requirements</span></h2>
      <div className="panel">
        <div className="covbar">
          <span className="operating" style={seg(c.operating)}>{c.operating || ''}</span>
          <span className="intended" style={seg(c.intended)}>{c.intended || ''}</span>
          <span className="weak" style={seg(c.weak)}>{c.weak || ''}</span>
          <span className="uncovered" style={seg(c.uncovered)}>{c.uncovered}</span>
        </div>
        <div className="coborg">
          <span><span className="dot" style={{ background: 'var(--held)' }} />operating {c.operating}</span>
          <span><span className="dot" style={{ background: 'var(--accent)' }} />intended {c.intended}</span>
          <span><span className="dot" style={{ background: 'var(--warn)' }} />weak {c.weak}</span>
          <span><span className="dot" style={{ background: 'var(--ink-3)' }} />uncovered {c.uncovered}</span>
        </div>
        <p className="notes" style={{ marginTop: '0.75rem' }}>
          A low-confidence edge shows as <b>weak</b> and is not counted as coverage; a planned or
          building control is <b>intended</b>, not <b>operating</b>. Zero operating is honest: nothing
          here is instrumented against real telemetry yet.
        </p>
        {c.mapped.length > 0 && (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Requirement</th><th>Family</th><th>State</th><th>Control(s)</th></tr>
              </thead>
              <tbody>
                {c.mapped.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{r.family}</td>
                    <td>{r.state}</td>
                    <td className="mono">{r.controls.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function SprsView({ s, latest }: { s: Sprs; latest: LatestAssertion[] }) {
  return (
    <>
      <h2>SPRS score <span className="h2note">— derived from assertion records, not a spreadsheet</span></h2>
      <div className="panel">
        {s.computed ? (
          <>
            <div>
              <span className="sprs-score">{s.score}</span>{' '}
              <span className="sprs-of">of {s.basis}</span>
            </div>
            <div className="notes" style={{ marginTop: '0.35rem' }}>
              {s.met} requirement(s) met, {s.unmet} unmet · deduction −{s.deduction} · at/above the
              88/110 conditional threshold: <b>{String(s.at_or_above_conditional_threshold)}</b>
            </div>
            {!s.submittable && (
              <div className="notsub">
                <b>NOT SUBMITTABLE.</b>{' '}
                {!s.weights_verified && 'Weights are unverified (verified: false) — the arithmetic ran; the inputs are not sourced. '}
                {s.evidence_is_fixture && 'Evidence set contains fixture assertions (NOT REAL EVIDENCE).'}
              </div>
            )}
            {s.stateCounts && (
              <div className="sprs-states">
                Requirement states:{' '}
                {Object.entries(s.stateCounts).sort().map(([k, v], i, arr) => (
                  <span key={k}>{v} {k}{i < arr.length - 1 ? ' · ' : ''}</span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="notsub" style={{ margin: 0 }}>
            <b>Score refused.</b> {s.message?.split('\n')[0]} This refusal is the point: a guessed
            weight is a wrong score submitted to a Government system of record.
          </div>
        )}
        <p className="notes" style={{ marginTop: '0.85rem' }}>
          How it is derived: a requirement is <i>met</i> only when every control crosswalked to it at
          better-than-low confidence has a latest assertion with <code>failing_count = 0</code>. The
          raw records below are what feed that:
        </p>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Control</th><th>as_of</th><th>total</th><th>passing</th><th>failing</th><th>query_ref</th></tr>
            </thead>
            <tbody>
              {latest.map((a) => (
                <tr key={a.control_id}>
                  <td className="mono">{a.control_id}</td>
                  <td className="mono">{a.as_of}</td>
                  <td>{a.total ?? '—'}</td>
                  <td>{a.passing_count ?? '—'}</td>
                  <td>{a.failing_count ?? '—'}{a.failing_enumerated != null ? ` (${a.failing_enumerated} listed)` : ''}</td>
                  <td className="mono" style={{ fontSize: '0.72rem' }}>{a.query_ref ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function VarianceView({ rows }: { rows: VarianceRow[] }) {
  return (
    <>
      <h2>Variance <span className="h2note">— Variance Frequency &amp; Duration, the risk half</span></h2>
      <div className="panel">
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Control</th><th>Snapshots</th><th>Window</th><th>Episodes</th>
                <th>VF /yr</th><th>VD days</th><th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.control_id}>
                  <td className="mono">{r.control_id}</td>
                  <td>{r.snapshots}</td>
                  <td>{r.window_days ?? 0}d</td>
                  <td>{r.episodes} ({r.closed} closed, {r.censored} open)</td>
                  <td>{r.variance_frequency_per_year ?? 'n/a'}{r.extrapolated ? ' *' : ''}</td>
                  <td>{r.variance_duration_days ?? '—'}</td>
                  <td className="notes">
                    {r.snapshots < 2 && 'single snapshot — a photograph, not a history'}
                    {r.extrapolated && '* annualised from a window < 90d (extrapolation) '}
                    {r.censored > 0 && r.variance_duration_days === null && 'all episodes censored — no duration '}
                    {r.saturated && 'queue saturated '}
                    {r.understated_episodes > 0 && `${r.understated_episodes} episode(s) understated (onset=detected)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="notes" style={{ marginTop: '0.6rem' }}>
          These are the inputs to control reliability, and thence to loss event frequency. A single
          snapshot gets no rate; a short window is labeled extrapolation; censored (still-open)
          episodes are excluded from the mean with the exclusion stated.
        </p>
      </div>
    </>
  );
}

function OscalView({ files }: { files: OscalFile[] }) {
  return (
    <>
      <h2>OSCAL O1–O5 <span className="h2note">— emitted with deterministic v5 UUIDs; re-exports byte-identically</span></h2>
      <div className="oscal">
        {files.map((f) => (
          <div className="ofile" key={f.name}>
            <div className="on">{f.name}</div>
            <div className="om">{f.model} · {f.bytes.toLocaleString()} bytes</div>
            <details className="oprev">
              <summary>Preview</summary>
              <pre>{f.preview}</pre>
            </details>
          </div>
        ))}
      </div>
      <p className="notes" style={{ marginTop: '0.5rem' }}>
        All artifacts carry the <span className="stamp">NOT REAL EVIDENCE</span> stamp in their
        metadata because they were generated from synthetic assertions. In the tool these also
        validate against NIST&apos;s <code>oscal-cli</code> as a blocking CI gate (that step needs
        Java and is not run in this browser demo).
      </p>
    </>
  );
}
