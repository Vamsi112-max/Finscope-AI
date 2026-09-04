'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.VERCEL
  ? path.join('/tmp', 'audit', 'trust-state.json')
  : path.join(__dirname, '..', 'audit', 'trust-state.json');

let inMemoryState = null;

const MISMATCH_TYPES = [
  'exact_match', 'date_lag', 'amount_rounding',
  'duplicate_entry', 'missing_reference', 'fx_variance',
  'retry_storm', 'refund_spike', 'decline_drift', 'unresolvable'
];

const TIER_THRESHOLDS = [
  { tier: 3, minValidated: 20, minConfidence: 0.75 },
  { tier: 2, minValidated: 5, minConfidence: 0.85 },
  { tier: 1, minValidated: 0, minConfidence: Infinity },
];

function loadState() {
  if (inMemoryState) return inMemoryState;
  if (!fs.existsSync(STATE_FILE)) return _defaultState();
  try {
    inMemoryState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return inMemoryState;
  } catch {
    return _defaultState();
  }
}

function saveState(state) {
  inMemoryState = state;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function _defaultState() {
  const types = {};
  MISMATCH_TYPES.forEach(t => {
    types[t] = { validated: 0, total: 0, lastUpdated: null };
  });
  return { types, lastReset: new Date().toISOString() };
}

function getTier(mismatchType) {
  const state = loadState();
  const validated = state.types[mismatchType]?.validated ?? 0;
  for (const { tier, minValidated } of TIER_THRESHOLDS) {
    if (validated >= minValidated) return tier;
  }
  return 1;
}

function getMinConfidence(mismatchType) {
  const state = loadState();
  const validated = state.types[mismatchType]?.validated ?? 0;
  for (const { minValidated, minConfidence } of TIER_THRESHOLDS) {
    if (validated >= minValidated) return minConfidence;
  }
  return Infinity;
}

function recordValidation(mismatchType, agreed = true) {
  const state = loadState();
  if (!state.types[mismatchType]) {
    state.types[mismatchType] = { validated: 0, total: 0, lastUpdated: null };
  }
  state.types[mismatchType].total += 1;
  if (agreed) state.types[mismatchType].validated += 1;
  state.types[mismatchType].lastUpdated = new Date().toISOString();
  saveState(state);
}

function getAllTiers() {
  const state = loadState();
  const result = {};
  MISMATCH_TYPES.forEach(t => {
    const s = state.types[t] ?? { validated: 0, total: 0, lastUpdated: null };
    result[t] = {
      ...s,
      tier: getTier(t),
      minConfidence: getMinConfidence(t),
    };
  });
  return result;
}

module.exports = { getTier, getMinConfidence, recordValidation, getAllTiers, loadState };
