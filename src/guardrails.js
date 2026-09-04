'use strict';

require('dotenv').config();

const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE ?? '0.7');
const MAX_VALUE = parseFloat(process.env.MAX_TRANSACTION_VALUE ?? '50000');

const VALID_MISMATCH_TYPES = new Set([
  'exact_match', 'date_lag', 'amount_rounding',
  'duplicate_entry', 'missing_reference', 'fx_variance', 'unresolvable'
]);

const VALID_ACTIONS = new Set([
  'auto_approve', 'flag_for_review', 'escalate_to_human', 'reject'
]);

function applyGuardrails(diagnosis, pair, tierMinConfidence = null) {
  const { internal } = pair;
  const txValue = internal?.amount ?? pair.gateway?.amount ?? 0;
  const effectiveMinConf = tierMinConfidence != null ? tierMinConfidence : MIN_CONFIDENCE;
  const guardrailsApplied = [];
  let finalDiagnosis = { ...diagnosis };

  const missingFields = [];
  if (!VALID_MISMATCH_TYPES.has(diagnosis.mismatchType)) missingFields.push('mismatchType');
  if (typeof diagnosis.confidence !== 'number') missingFields.push('confidence');
  if (!VALID_ACTIONS.has(diagnosis.suggestedAction)) missingFields.push('suggestedAction');

  if (missingFields.length > 0) {
    guardrailsApplied.push({
      rule: 'invalid_output',
      detail: `Missing or invalid fields: ${missingFields.join(', ')}`,
      override: 'escalate_to_human'
    });
    finalDiagnosis.suggestedAction = 'escalate_to_human';
    finalDiagnosis.confidence = 0.0;
    finalDiagnosis.guardrailOverride = true;
    return { ...finalDiagnosis, guardrailsApplied, guardedAt: new Date().toISOString() };
  }

  if (txValue > MAX_VALUE && finalDiagnosis.suggestedAction === 'auto_approve') {
    guardrailsApplied.push({
      rule: 'high_value_cap',
      detail: `Transaction value ₹${txValue.toLocaleString('en-IN')} exceeds cap of ₹${MAX_VALUE.toLocaleString('en-IN')}`,
      override: 'escalate_to_human'
    });
    finalDiagnosis.suggestedAction = 'escalate_to_human';
    finalDiagnosis.guardrailOverride = true;
  }

  if (
    finalDiagnosis.confidence < effectiveMinConf &&
    !['escalate_to_human', 'reject'].includes(finalDiagnosis.suggestedAction)
  ) {
    guardrailsApplied.push({
      rule: 'low_confidence',
      detail: `Confidence ${finalDiagnosis.confidence.toFixed(2)} below threshold ${effectiveMinConf.toFixed(2)}`,
      override: 'escalate_to_human'
    });
    finalDiagnosis.suggestedAction = 'escalate_to_human';
    finalDiagnosis.guardrailOverride = true;
  }

  if (diagnosis.llmError) {
    guardrailsApplied.push({
      rule: 'model_error',
      detail: diagnosis.llmError,
      override: 'escalate_to_human'
    });
    finalDiagnosis.suggestedAction = 'escalate_to_human';
    finalDiagnosis.guardrailOverride = true;
  }

  return {
    ...finalDiagnosis,
    guardrailsApplied,
    guardrailOverride: finalDiagnosis.guardrailOverride ?? false,
    guardedAt: new Date().toISOString()
  };
}

module.exports = { applyGuardrails };
