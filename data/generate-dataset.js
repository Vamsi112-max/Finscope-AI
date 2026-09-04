'use strict';

const fs = require('fs');
const path = require('path');

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function uid(p = 'ID') {
  return `${p}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

const VENDORS = [
  'Apex Logistics', 'Blue River Corp', 'Crestwood Supplies',
  'Delta Freight', 'Echo Analytics', 'Frontier Services',
  'Gamma Consulting', 'Horizon Capital', 'Indigo Tech',
  'Jasper Holdings', 'Kinetic Media', 'Luminary Solutions'
];

const ACCOUNTS = ['4001', '4002', '5001', '5002', '6001', '6002', '7001'];
const BANKS = ['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK'];
const DECLINE_CODES = ['INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'TIMEOUT', 'FRAUD_SUSPECTED', 'CARD_EXPIRED', 'INVALID_ACCOUNT'];

const BASE_MS = new Date('2024-06-01').getTime();

function rdate(offsetDays = 0) {
  const d = new Date(BASE_MS + (randInt(0, 89) + offsetDays) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function addDays(ds, n) {
  const d = new Date(ds);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoTs(dateStr, hourOffset = 0) {
  return `${dateStr}T${String(8 + hourOffset).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00+05:30`;
}

function makeGateway(opts = {}) {
  const { declineCode = null, retryCount = 0, status = 'authorized', amount, date, vendor } = opts;
  return {
    id: uid('GW'),
    timestamp: isoTs(date, randInt(0, 10)),
    amount,
    currency: 'INR',
    vendor,
    bank: pick(BANKS),
    authCode: status === 'authorized' ? uid('AUTH') : null,
    retryCount,
    declineCode,
    status,
  };
}

function makeSettlement(opts = {}) {
  const { amount, gatewayDate, lag = 1, status = 'settled', fxAmount = null, fxCurrency = null } = opts;
  const settlementDate = addDays(gatewayDate, lag);
  return {
    id: uid('SET'),
    utr: uid('UTR'),
    batchId: `BATCH-${settlementDate.replace(/-/g, '')}`,
    settlementDate,
    amount: fxAmount ?? amount,
    currency: fxCurrency ?? 'INR',
    originalAmount: amount,
    originalCurrency: 'INR',
    status,
  };
}

function makeLedger(opts = {}) {
  const { amount, date, vendor, ref, account } = opts;
  return {
    id: uid('LED'),
    bookingDate: date,
    amount,
    currency: 'INR',
    accountCode: account ?? pick(ACCOUNTS),
    reference: ref,
    vendor,
  };
}

function makeExactMatch() {
  const date = rdate();
  const amount = parseFloat(rand(1000, 80000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount, date, vendor }),
    settlement: makeSettlement({ amount, gatewayDate: date, lag: 1 }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'exact_match',
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeDateLag() {
  const date = rdate();
  const lag = pick([3, 4, 5, 6, 7]);
  const amount = parseFloat(rand(5000, 120000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount, date, vendor }),
    settlement: makeSettlement({ amount, gatewayDate: date, lag }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'date_lag',
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeAmountRounding() {
  const date = rdate();
  const base = parseFloat(rand(2000, 60000).toFixed(2));
  const delta = parseFloat((rand(0.01, 0.49) * pick([-1, 1])).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount: base, date, vendor }),
    settlement: makeSettlement({ amount: parseFloat((base + delta).toFixed(2)), gatewayDate: date }),
    ledger: makeLedger({ amount: base, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'amount_rounding',
    delta,
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeDuplicateEntry() {
  const date = rdate();
  const amount = parseFloat(rand(5000, 50000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  const lagDays = pick([1, 2]);
  return {
    gateway: makeGateway({ amount, date, vendor }),
    settlement: makeSettlement({ amount, gatewayDate: date, lag: lagDays }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'duplicate_entry',
    duplicateLagDays: lagDays,
    anomalySignals: { isDuplicateSuspect: true, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeMissingReference() {
  const date = rdate();
  const amount = parseFloat(rand(3000, 40000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = pick(['', null, 'N/A', 'MISSING', '???']);
  return {
    gateway: makeGateway({ amount, date, vendor }),
    settlement: makeSettlement({ amount, gatewayDate: date }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref: uid('REF') }),
    externalRef: ref,
    expectedMismatch: 'missing_reference',
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeRetryStorm() {
  const date = rdate();
  const amount = parseFloat(rand(10000, 90000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  const retries = randInt(4, 7);
  return {
    gateway: makeGateway({ amount, date, vendor, retryCount: retries, declineCode: pick(['TIMEOUT', 'DO_NOT_HONOR']), status: 'authorized' }),
    settlement: makeSettlement({ amount, gatewayDate: date, lag: 2 }),
    ledger: makeLedger({ amount, date: addDays(date, 2), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'date_lag',
    anomalySignals: { isDuplicateSuspect: false, retryStorm: true, retryCount: retries, refundSpike: false, declineRateDrift: false }
  };
}

function makeFXVariance() {
  const date = rdate();
  const fxMap = { USD: 83.5, EUR: 90.2, GBP: 105.8, AUD: 54.3 };
  const fxCurrency = pick(Object.keys(fxMap));
  const baseINR = parseFloat(rand(20000, 200000).toFixed(2));
  const slippage = parseFloat((rand(-0.02, 0.02)).toFixed(4));
  const fxRate = fxMap[fxCurrency];
  const fxAmount = parseFloat((baseINR / (fxRate + slippage)).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount: baseINR, date, vendor }),
    settlement: makeSettlement({ amount: fxAmount, gatewayDate: date, fxAmount, fxCurrency }),
    ledger: makeLedger({ amount: baseINR, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'fx_variance',
    fxCurrency,
    fxRate: fxRate + slippage,
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: false }
  };
}

function makeRefundSpike(group = 1) {
  const date = rdate();
  const amount = parseFloat(rand(-20000, -500).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount: Math.abs(amount), date, vendor }),
    settlement: makeSettlement({ amount, gatewayDate: date }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'missing_reference',
    isRefund: true,
    refundGroup: group,
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: true, declineRateDrift: false }
  };
}

function makeDeclineDrift() {
  const date = rdate();
  const amount = parseFloat(rand(5000, 50000).toFixed(2));
  const vendor = pick(VENDORS);
  const ref = uid('REF');
  return {
    gateway: makeGateway({ amount, date, vendor, status: 'declined', declineCode: pick(['DO_NOT_HONOR', 'FRAUD_SUSPECTED']), retryCount: randInt(1, 3) }),
    settlement: makeSettlement({ amount, gatewayDate: date, status: 'pending' }),
    ledger: makeLedger({ amount, date: addDays(date, 1), vendor, ref }),
    externalRef: ref,
    expectedMismatch: 'missing_reference',
    anomalySignals: { isDuplicateSuspect: false, retryStorm: false, refundSpike: false, declineRateDrift: true }
  };
}

const plan = [
  { fn: makeExactMatch, count: 55 },
  { fn: makeDateLag, count: 25 },
  { fn: makeAmountRounding, count: 22 },
  { fn: makeDuplicateEntry, count: 18 },
  { fn: makeMissingReference, count: 12 },
  { fn: makeRetryStorm, count: 8 },
  { fn: makeFXVariance, count: 8 },
  { fn: makeRefundSpike, count: 7 },
  { fn: makeDeclineDrift, count: 5 },
];

const transactions = [];
let idx = 0;

for (const { fn, count } of plan) {
  for (let i = 0; i < count; i++) {
    const pair = fn(i);
    transactions.push({
      pairId: `PAIR-${String(++idx).padStart(3, '0')}`,
      ...pair
    });
  }
}

transactions.sort(() => Math.random() - 0.5);

const out = path.join(__dirname, 'transactions.json');
fs.writeFileSync(out, JSON.stringify(transactions, null, 2));

console.log(`Generated ${transactions.length} records in data/transactions.json`);

module.exports = { transactions };
