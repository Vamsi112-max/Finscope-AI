'use strict';

const { runMatcher } = require('../matcher');
const { diagnosePair } = require('../llmDiagnose');
const { applyGuardrails } = require('../guardrails');
const { getTier, getMinConfidence } = require('../trustTier');

function adaptForMatcher(transactions) {
  return transactions.map(t => ({
    pairId: t.pairId,
    expectedMismatch: t.expectedMismatch,
    duplicateFlag: t.anomalySignals?.isDuplicateSuspect,
    internal: {
      id: t.ledger?.id,
      ref: t.externalRef ?? t.ledger?.reference,
      date: t.ledger?.bookingDate ?? t.gateway?.timestamp?.slice(0, 10),
      amount: t.ledger?.amount ?? t.gateway?.amount,
      currency: t.ledger?.currency ?? 'INR',
      vendor: t.ledger?.vendor ?? t.gateway?.vendor,
      account: t.ledger?.accountCode,
    },
    external: {
      id: t.settlement?.id,
      ref: t.externalRef,
      date: t.settlement?.settlementDate,
      amount: t.settlement?.amount,
      currency: t.settlement?.currency ?? 'INR',
      vendor: t.gateway?.vendor,
    },
    _raw: t,
  }));
}

async function runReconciliationAgent(transactions, opts = {}) {
  const adapted = adaptForMatcher(transactions);
  const { resolved, exceptions } = runMatcher(adapted);
  const allResults = [];

  for (const r of resolved) {
    const tier = getTier(r.rule ?? r.expectedMismatch ?? 'unknown');
    const minConf = getMinConfidence(r.rule ?? r.expectedMismatch ?? 'unknown');

    let finalStatus = r.status;
    if (r.status === 'matched' && r.confidence < minConf && tier < 3) {
      finalStatus = 'flag_for_review';
    }

    allResults.push({
      ...r,
      _raw: r._raw ?? adapted.find(a => a.pairId === r.pairId)?._raw,
      gateway: r._raw?.gateway,
      settlement: r._raw?.settlement,
      ledger: r._raw?.ledger,
      trustTier: tier,
      resolvedBy: 'rule_engine',
      status: finalStatus,
      suggestedAction: finalStatus === 'matched' ? 'auto_approve' : 'flag_for_review',
      timestamp: new Date().toISOString(),
    });
  }

  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const hasRealKey = key && key.startsWith('sk-ant-') && !key.includes('...') && !key.includes('YOUR_KEY_HERE') && key.length > 20;

  for (const pair of exceptions) {
    let llmResult;

    if (opts.skipLLM || !hasRealKey) {
      llmResult = {
        mismatchType: pair.expectedMismatch,
        confidence: 0.61,
        reasoning: 'Automated fallback - flagged for manual review.',
        suggestedAction: 'flag_for_review',
        rawResponse: null,
        llmError: null,
      };
    } else {
      llmResult = await diagnosePair(pair);
    }

    const minConf = getMinConfidence(llmResult.mismatchType ?? 'unknown');
    const guarded = applyGuardrails(llmResult, pair, minConf);
    const raw = pair._raw ?? adapted.find(a => a.pairId === pair.pairId)?._raw;

    allResults.push({
      ...pair,
      ...guarded,
      gateway: raw?.gateway,
      settlement: raw?.settlement,
      ledger: raw?.ledger,
      _raw: raw,
      trustTier: getTier(llmResult.mismatchType ?? 'unknown'),
      resolvedBy: 'llm_pipeline',
      status: guarded.suggestedAction,
      timestamp: new Date().toISOString(),
    });
  }

  const summary = {
    total: allResults.length,
    resolvedByRules: resolved.length,
    resolvedByLLM: allResults.filter(r => r.resolvedBy === 'llm_pipeline' && r.suggestedAction === 'auto_approve').length,
    flaggedForReview: allResults.filter(r => r.suggestedAction === 'flag_for_review').length,
    escalatedToHuman: allResults.filter(r => r.suggestedAction === 'escalate_to_human').length,
    duplicates: allResults.filter(r => r.status === 'flagged_duplicate').length,
    guardrailOverrides: allResults.filter(r => r.guardrailOverride).length,
  };

  return { agent: 'reconciliation', summary, results: allResults };
}

module.exports = { runReconciliationAgent };
