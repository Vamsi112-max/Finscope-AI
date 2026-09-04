'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { runAll } = require('./orchestrator');
const { runPipeline } = require('./pipeline');
const { askCopilot } = require('./agents/financialCopilot');
const { getAllTiers, recordValidation } = require('./trustTier');

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const DATA_FILE = path.join(__dirname, '..', 'data', 'transactions.json');
const AUDIT_DIR = process.env.VERCEL ? path.join('/tmp', 'audit') : path.join(__dirname, '..', 'audit');
const CORR_FILE = path.join(AUDIT_DIR, 'corrections.json');
const CACHE_DIR = path.join(AUDIT_DIR, 'cache');

[AUDIT_DIR, CACHE_DIR].forEach(d => {
  if (!fs.existsSync(d)) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
});

function load(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadTransactions() {
  return load(DATA_FILE);
}

function loadCorrections() {
  return load(CORR_FILE, []);
}

function loadLastRun() {
  return load(path.join(CACHE_DIR, 'last-run.json'));
}

function isRealApiKey(key) {
  if (!key) return false;
  const k = key.trim();
  return k.startsWith('sk-ant-') && !k.includes('...') && !k.includes('YOUR_KEY_HERE') && k.length > 20;
}

app.get('/api/dataset', (req, res) => {
  const txns = loadTransactions();
  if (!txns) return res.status(404).json({ error: 'Dataset not found' });

  const breakdown = {};
  const anomalyTypes = {};
  txns.forEach(t => {
    breakdown[t.expectedMismatch] = (breakdown[t.expectedMismatch] || 0) + 1;
    Object.entries(t.anomalySignals ?? {}).forEach(([k, v]) => {
      if (v) anomalyTypes[k] = (anomalyTypes[k] || 0) + 1;
    });
  });

  const hasApiKey = isRealApiKey(process.env.ANTHROPIC_API_KEY);

  res.json({
    total: txns.length,
    breakdown,
    anomalyTypes,
    hasApiKey,
    stubMode: !hasApiKey,
    layers: ['gateway', 'settlement', 'ledger'],
  });
});

app.get('/api/download-dataset', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'Dataset not found' });
  res.setHeader('Content-Disposition', 'attachment; filename="finscope-dataset.json"');
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(DATA_FILE).pipe(res);
});

app.post('/api/upload-dataset', (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid format: Expected a JSON array of transactions.'
    });
  }

  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (typeof t !== 'object' || t === null) {
      return res.status(400).json({
        success: false,
        error: `Row #${i + 1} is invalid: Expected a JSON object.`
      });
    }
    const id = t.pairId || t.id || t.ref || t.reference;
    if (!id) {
      return res.status(400).json({
        success: false,
        error: `Row #${i + 1} validation failed: Missing unique record identifier.`
      });
    }
    const amt = t.amount ?? t.internal?.amount ?? t.gateway?.amount ?? t.settlement?.amount;
    if (amt === undefined || amt === null || isNaN(Number(amt))) {
      return res.status(400).json({
        success: false,
        error: `Row #${i + 1} (${id}) validation failed: Missing or non-numeric transaction amount.`
      });
    }
  }

  const normalized = transactions.map((t, idx) => {
    const pairId = t.pairId || t.id || `TXN-CUSTOM-${String(idx + 1).padStart(3, '0')}`;
    const amount = Number(t.amount ?? t.internal?.amount ?? t.gateway?.amount ?? t.settlement?.amount ?? 0);
    const vendor = t.vendor || t.internal?.vendor || t.gateway?.vendor || 'Merchant General';
    const date = t.date || t.internal?.date || t.gateway?.timestamp?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const expectedMismatch = t.expectedMismatch || t.mismatchType || 'exact_match';

    return {
      pairId,
      expectedMismatch,
      gateway: t.gateway || {
        id: `GW-${pairId}`,
        timestamp: `${date}T10:00:00+05:30`,
        amount,
        currency: t.currency || 'INR',
        vendor,
        status: t.status || 'captured',
        declineCode: t.declineCode || null,
        retryCount: t.retryCount || 0,
        bank: t.bank || 'HDFC'
      },
      settlement: t.settlement || {
        utr: `UTR_${pairId}`,
        settlementDate: date,
        amount,
        currency: t.currency || 'INR',
        status: 'settled'
      },
      ledger: t.ledger || t.internal || {
        reference: pairId,
        bookingDate: date,
        amount,
        accountCode: t.accountCode || '4001',
        vendor
      },
      internal: t.internal || {
        ref: pairId,
        date,
        amount,
        currency: t.currency || 'INR',
        vendor,
        account: t.accountCode || '4001'
      },
      anomalySignals: t.anomalySignals || {
        isDuplicateSuspect: false,
        retryStorm: false,
        refundSpike: false,
        declineRateDrift: false
      }
    };
  });

  save(DATA_FILE, normalized);
  const lastRunPath = path.join(CACHE_DIR, 'last-run.json');
  if (fs.existsSync(lastRunPath)) fs.unlinkSync(lastRunPath);

  res.json({
    success: true,
    total: normalized.length,
    message: `Loaded ${normalized.length} transactions successfully.`
  });
});

app.post('/api/reset-sample-dataset', (req, res) => {
  try {
    const { execSync } = require('child_process');
    execSync('node data/generate-dataset.js', { cwd: path.join(__dirname, '..') });
    const lastRunPath = path.join(CACHE_DIR, 'last-run.json');
    if (fs.existsSync(lastRunPath)) fs.unlinkSync(lastRunPath);
    const txns = loadTransactions();
    res.json({
      success: true,
      total: txns ? txns.length : 160,
      message: 'Sample dataset restored.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/run-all', async (req, res) => {
  const txns = loadTransactions();
  if (!txns) return res.status(404).json({ error: 'Dataset not found' });

  try {
    const result = await runAll(txns);
    save(path.join(CACHE_DIR, 'last-run.json'), result);
    res.json(result);
  } catch (err) {
    console.error('Execution error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/anomalies', (req, res) => {
  const last = loadLastRun();
  if (!last) return res.status(404).json({ error: 'No run found. Please trigger reconciliation first.' });
  res.json(last.anomalies);
});

app.get('/api/forecast', (req, res) => {
  const last = loadLastRun();
  if (!last) return res.status(404).json({ error: 'No run found. Please trigger reconciliation first.' });
  res.json(last.forecast);
});

app.post('/api/copilot', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  const last = loadLastRun();
  const context = {
    reconciliation: last?.reconciliation ?? {},
    anomalies: last?.anomalies ?? {},
    forecast: last?.forecast ?? {},
  };

  try {
    const answer = await askCopilot(question, context);
    res.json(answer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trust-state', (req, res) => {
  res.json(getAllTiers());
});

app.get('/api/audits', (req, res) => {
  if (!fs.existsSync(AUDIT_DIR)) return res.json([]);
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort().reverse()
    .map(f => ({
      runId: f.replace(/^run-|\.json$/g, ''),
      filename: f,
      url: `/api/audit/${encodeURIComponent(f.replace(/^run-|\.json$/g, ''))}`
    }));
  res.json(files);
});

app.get('/api/audit/:runId', (req, res) => {
  const fp = path.join(AUDIT_DIR, `run-${req.params.runId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.json(load(fp));
});

app.post('/api/correction', (req, res) => {
  const { pairId, runId, correctedMismatchType, correctedAction, note, reviewerName, agreeWithAgent } = req.body;
  if (!pairId || !runId || !correctedMismatchType) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const corrections = loadCorrections();
  const corr = {
    id: `CORR-${Date.now()}`,
    pairId,
    runId,
    correctedMismatchType,
    correctedAction: correctedAction ?? 'manual_override',
    note: note ?? '',
    reviewerName: reviewerName ?? 'reviewer',
    agreeWithAgent: agreeWithAgent ?? false,
    submittedAt: new Date().toISOString()
  };
  corrections.push(corr);
  save(CORR_FILE, corrections);

  recordValidation(correctedMismatchType, agreeWithAgent === true);

  res.json({ success: true, correction: corr, trustState: getAllTiers()[correctedMismatchType] });
});

app.get('/api/corrections', (req, res) => res.json(loadCorrections()));

app.post('/api/run', async (req, res) => {
  const txns = loadTransactions();
  if (!txns) return res.status(404).json({ error: 'Dataset not found' });
  try {
    const result = await runPipeline(txns);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = app;
