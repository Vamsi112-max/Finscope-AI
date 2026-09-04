'use strict';

const fs = require('fs');
const path = require('path');

const { runMatcher } = require('./matcher');
const { diagnosePair } = require('./llmDiagnose');
const { applyGuardrails } = require('./guardrails');

const AUDIT_DIR = process.env.VERCEL
  ? path.join('/tmp', 'audit')
  : path.join(__dirname, '..', 'audit');

try {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
} catch {}

function statusBadge(result) {
  if (result.resolvedBy === 'rule_engine') return result.status;
  return result.suggestedAction ?? 'unknown';
}

function writeAuditLog(runId, data) {
  const filePath = path.join(AUDIT_DIR, `run-${runId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {}
  return filePath;
}

async function runPipeline(pairs, opts = {}) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const allResults = [];

  const { resolved, exceptions } = runMatcher(pairs);
  allResults.push(...resolved);

  for (let i = 0; i < exceptions.length; i++) {
    const pair = exceptions[i];
    let llmResult;

    if (opts.skipLLM || !process.env.ANTHROPIC_API_KEY) {
      llmResult = {
        mismatchType: pair.expectedMismatch,
        confidence: 0.61,
        reasoning: 'Automated fallback - manual review needed.',
        suggestedAction: 'flag_for_review',
        rawResponse: null,
        llmError: null
      };
    } else {
      llmResult = await diagnosePair(pair);
    }

    const guarded = applyGuardrails(llmResult, pair);

    const finalResult = {
      ...pair,
      ...guarded,
      resolvedBy: 'llm_pipeline',
      status: statusBadge(guarded),
    };

    allResults.push(finalResult);
  }

  const summary = {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    total: allResults.length,
    resolvedByRules: resolved.length,
    resolvedByLLM: allResults.filter(r => r.resolvedBy === 'llm_pipeline' && r.suggestedAction === 'auto_approve').length,
    flaggedForReview: allResults.filter(r => r.suggestedAction === 'flag_for_review').length,
    escalatedToHuman: allResults.filter(r => r.suggestedAction === 'escalate_to_human').length,
    duplicates: allResults.filter(r => r.status === 'flagged_duplicate').length,
    guardrailOverrides: allResults.filter(r => r.guardrailOverride).length,
  };

  const auditPayload = { summary, results: allResults };
  const auditPath = writeAuditLog(runId, auditPayload);

  return { summary, results: allResults, auditPath };
}

module.exports = { runPipeline };
