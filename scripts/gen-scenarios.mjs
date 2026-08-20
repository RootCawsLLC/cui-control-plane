#!/usr/bin/env node
// Writes the scenario registry under scenarios/.
//
// Generated for the same reason the requirement index is: the set is small, closed, and derived
// from the control records that reference it, so a generator plus a diff test is cheaper to trust
// than six hand-maintained files that can silently drift out of sync with the controls.
//
// The quantification block on every scenario is null and stays null. These become computable once
// the pipeline has produced Variance Frequency and Variance Duration on the controls that serve
// each scenario; filling them in from intuition before then is precisely the practice this
// repository exists to argue against.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SCENARIOS = [
  {
    scenario_id: 'scn.cui-exfil.enclave',
    title: 'CUI is exfiltrated from the enclave',
    loss_event:
      'Controlled Unclassified Information held inside the enclave boundary is copied out by an ' +
      'unauthorised party and leaves organisational control.',
    threat_community: 'External state-aligned actor targeting defence industrial base contractors',
    asset: 'CUI at rest and in transit within the enclave boundary',
    effect: ['confidentiality'],
    status: 'identified',
    loss_forms: ['response', 'fines-and-judgements', 'contractual', 'reputation', 'competitive-advantage'],
    notes:
      'The dominant scenario in this programme. Note that contractual loss is not a secondary ' +
      'consideration here the way it is in a commercial breach: the safeguarding clause is a term ' +
      'of the contract, so a failure is simultaneously a security event and a breach of contract.',
  },
  {
    scenario_id: 'scn.cred-theft.cui-enclave',
    title: 'Enclave credentials are stolen and reused',
    loss_event:
      'An authentication credential for a human identity in the enclave IdP is captured and used ' +
      'by an unauthorised party to authenticate as that identity.',
    threat_community: 'Phishing and credential-harvesting operators, including access brokers',
    asset: 'Human identities in the CUI enclave identity provider',
    effect: ['confidentiality', 'integrity'],
    status: 'identified',
    loss_forms: ['response', 'productivity'],
    notes:
      'Usually a precursor rather than a terminal event - it is the most common first step toward ' +
      'scn.cui-exfil.enclave. Kept separate because the controls that resist it and the controls ' +
      'that limit what follows it are different controls with different owners.',
  },
  {
    scenario_id: 'scn.phish.bec',
    title: 'Business email compromise against corporate identities',
    loss_event:
      'A corporate identity outside the enclave is compromised and used for fraud, lateral ' +
      'movement, or impersonation.',
    threat_community: 'Financially motivated criminal actors',
    asset: 'Human identities in the corporate identity provider',
    effect: ['confidentiality', 'integrity'],
    status: 'identified',
    loss_forms: ['response', 'productivity', 'replacement'],
    notes:
      'OUT OF THE CMMC ASSESSMENT BOUNDARY, and in the register anyway. No assessor scores it; the ' +
      'business carries it regardless. This scenario is the reason ctl.iam.corp-it.mfa exists as a ' +
      'separate control rather than being folded into the enclave one.',
  },
  {
    scenario_id: 'scn.scrm.prohibited-entity',
    title: 'A prohibited entity is present in the supply chain',
    loss_event:
      'The organisation contracts with, renews with, or extends an entity that is on the ' +
      'Section 1260H list or subject to a FASC exclusion or removal order, or fails to detect a ' +
      'controlled affiliate of one.',
    threat_community:
      'Not an adversary acting against us - the loss arises from a compliance state, and the ' +
      'threat community is the regulator and the contracting officer. Recorded explicitly because ' +
      'forcing every scenario into an attacker frame is how supply-chain obligations get ' +
      'mis-modelled.',
    asset: 'Supplier and subcontractor relationships in the supplier master',
    effect: ['integrity'],
    status: 'identified',
    loss_forms: ['fines-and-judgements', 'contractual', 'reputation'],
    notes:
      'No cure period exists - the prohibition bars contracting rather than granting time to ' +
      'remediate - so Variance Duration here is a measure of exposure already incurred, not of ' +
      'time remaining. That distinction matters when this is eventually quantified.',
  },
  {
    scenario_id: 'scn.scrm.covered-telecom',
    title: 'Covered telecommunications equipment is in use',
    loss_event:
      'Covered telecommunications or video surveillance equipment is present as a substantial or ' +
      'essential component of a system, or the annual representation is made inaccurately because ' +
      'the component population was never established.',
    threat_community:
      'Regulator and contracting officer, plus the supply-chain tampering risk the prohibition ' +
      'exists to address. Both, and they are not the same thing.',
    asset: 'Hardware and software components in and adjacent to the CUI boundary',
    effect: ['confidentiality', 'integrity'],
    status: 'identified',
    loss_forms: ['fines-and-judgements', 'contractual', 'replacement'],
    notes:
      'The False Claims Act exposure attaches to the representation, not only to the equipment. ' +
      'That is why the control tests the population rather than collecting an attestation, and ' +
      'why an unresolved manufacturer is a failure rather than an absence.',
  },
  {
    scenario_id: 'scn.dfars.late-report',
    title: 'A reportable cyber incident is reported late or not at all',
    loss_event:
      'A cyber incident affecting a covered contractor information system or the CUI it holds is ' +
      'submitted to DIBNet more than 72 hours after discovery, or is misclassified as ' +
      'non-reportable and never submitted.',
    threat_community: 'Regulator and contracting officer, following an incident that has already occurred',
    asset: 'The reporting obligation under the safeguarding clause',
    effect: ['integrity'],
    status: 'identified',
    loss_forms: ['fines-and-judgements', 'contractual', 'reputation'],
    notes:
      'A SECONDARY loss scenario - it can only occur once a primary event has. Its frequency is ' +
      'therefore conditional on the frequency of the events that trigger reporting, which is the ' +
      'shape a secondary loss event frequency takes and is why it is not modelled as independent. ' +
      'The misclassification path matters as much as the late-submission path, which is why ' +
      'non-reportable incidents stay in the control population.',
  },
];

function yaml(s) {
  const q = (v) => JSON.stringify(v);
  const lines = [
    '# GENERATED by scripts/gen-scenarios.mjs - do not hand edit.',
    '#',
    '# Structure only. quantification stays null until the pipeline produces Variance Frequency and',
    '# Variance Duration on the controls that serve this scenario - see docs/watch-items.md.',
    '',
    `scenario_id: ${s.scenario_id}`,
    `title: ${q(s.title)}`,
    `loss_event: ${q(s.loss_event)}`,
    `threat_community: ${q(s.threat_community)}`,
    `asset: ${q(s.asset)}`,
    `effect: [${s.effect.join(', ')}]`,
    `status: ${s.status}`,
    `loss_forms: [${s.loss_forms.join(', ')}]`,
    'quantification:',
    '  lef: null',
    '  lm: null',
    '  confidence_tier: null',
    '  blocked_on: "No control measurement exists yet. LEF needs Variance Frequency and control reliability from the pipeline; LM needs loss data this repository does not hold."',
    `notes: ${q(s.notes)}`,
  ];
  return `${lines.join('\n')}\n`;
}

mkdirSync(join(root, 'scenarios'), { recursive: true });
for (const s of SCENARIOS) {
  writeFileSync(join(root, 'scenarios', `${s.scenario_id}.yaml`), yaml(s));
}
console.log(`wrote ${SCENARIOS.length} scenarios`);
