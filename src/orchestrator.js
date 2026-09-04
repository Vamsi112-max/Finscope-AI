'use strict';

const fs = require('fs');
const path = require('path');

const { runReconciliationAgent } = require('./agents/reconciliationAgent');
const { runAnomalyWatch } = require('./agents/anomalyWatchAgent');
const { runCashFlowForecast } = require('./agents/cashFlowForecastAgent');

const AUDIT_DIR = process.env.VERCEL
  ? path.join('/tmp', 'audit')
  : path.join(__dirname, '..', 'audit');

try {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
} catch {}

function writeAudit(runId, payload) {
  const p = path.join(AUDIT_DIR, `run-${runId}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {}
  return p;
}

async function runAll(transactions, opts = {}) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();

  const [recon, anomalies, forecast] = await Promise.all([
    runReconciliationAgent(transactions, opts),
    Promise.resolve(runAnomalyWatch(transactions)),
    Promise.resolve(runCashFlowForecast(transactions)),
  ]);

  const completedAt = new Date().toISOString();

  const masterSummary = {
    runId,
    startedAt,
    completedAt,
    totalTransactions: transactions.length,
    reconciliation: recon.summary,
    anomalies: {
      alertCount: anomalies.alertCount,
      riskScore: anomalies.riskScore,
      riskLevel: anomalies.riskLevel,
    },
    forecast: {
      hasShortfall: forecast.hasShortfall,
      shortfallCount: forecast.shortfallDays.length,
    },
  };

  const auditPayload = { summary: masterSummary, reconciliation: recon, anomalies, forecast };
  const auditPath = writeAudit(runId, auditPayload);

  return { runId, summary: masterSummary, reconciliation: recon, anomalies, forecast, auditPath };
}

module.exports = { runAll };
