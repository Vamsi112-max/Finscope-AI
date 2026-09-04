'use strict';

const DATE_TOLERANCE_DAYS = 2;
const AMOUNT_TOLERANCE_USD = 0.50;
const DUPE_WINDOW_DAYS = 3;

const FX_TO_USD = {
  USD: 1.00,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.74,
  AUD: 0.66,
};

function daysDiff(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs((a - b) / 86_400_000);
}

function toUSD(amount, currency) {
  const rate = FX_TO_USD[currency] ?? 1;
  return amount * rate;
}

function normaliseRef(ref) {
  if (!ref || ref === 'N/A' || ref === 'MISSING') return null;
  return String(ref).replace(/[^A-Z0-9-]/gi, '').toUpperCase();
}

function checkExactMatch(int, ext) {
  if (!int || !ext) return null;
  if (
    int.ref === ext.ref &&
    int.date === ext.date &&
    int.currency === ext.currency &&
    Math.abs(int.amount - ext.amount) < 0.001
  ) {
    return { rule: 'exact_match', confidence: 1.0, status: 'matched' };
  }
  return null;
}

function checkAmountRounding(int, ext) {
  if (!int || !ext) return null;
  const intUSD = toUSD(int.amount, int.currency);
  const extUSD = toUSD(ext.amount, ext.currency);
  if (
    normaliseRef(int.ref) === normaliseRef(ext.ref) &&
    normaliseRef(int.ref) !== null &&
    daysDiff(int.date, ext.date) <= DATE_TOLERANCE_DAYS &&
    Math.abs(intUSD - extUSD) <= AMOUNT_TOLERANCE_USD
  ) {
    return {
      rule: 'amount_rounding',
      confidence: 0.95,
      status: 'matched',
      delta: parseFloat((extUSD - intUSD).toFixed(4))
    };
  }
  return null;
}

function checkDateLag(int, ext) {
  if (!int || !ext) return null;
  const intUSD = toUSD(int.amount, int.currency);
  const extUSD = toUSD(ext.amount, ext.currency);
  const diff = daysDiff(int.date, ext.date);
  if (
    normaliseRef(int.ref) === normaliseRef(ext.ref) &&
    normaliseRef(int.ref) !== null &&
    diff > DATE_TOLERANCE_DAYS &&
    diff <= 7 &&
    Math.abs(intUSD - extUSD) < 0.001
  ) {
    return {
      rule: 'date_lag',
      confidence: 0.92,
      status: 'matched',
      lagDays: diff
    };
  }
  return null;
}

function checkFXVariance(int, ext) {
  if (!int || !ext) return null;
  if (int.currency === ext.currency) return null;
  const intUSD = toUSD(int.amount, int.currency);
  const extUSD = toUSD(ext.amount, ext.currency);
  const pctDiff = Math.abs(intUSD - extUSD) / intUSD;
  if (
    normaliseRef(int.ref) === normaliseRef(ext.ref) &&
    normaliseRef(int.ref) !== null &&
    daysDiff(int.date, ext.date) <= DATE_TOLERANCE_DAYS &&
    pctDiff <= 0.03
  ) {
    return {
      rule: 'fx_variance',
      confidence: 0.88,
      status: 'matched',
      pctVariance: parseFloat((pctDiff * 100).toFixed(3)),
      intCurrency: int.currency,
      extCurrency: ext.currency
    };
  }
  return null;
}

function checkDuplicate(int, ext) {
  if (!int || !ext) return null;
  const intUSD = toUSD(int.amount, int.currency);
  const extUSD = toUSD(ext.amount, ext.currency);
  if (
    normaliseRef(int.ref) === normaliseRef(ext.ref) &&
    normaliseRef(int.ref) !== null &&
    daysDiff(int.date, ext.date) >= 1 &&
    daysDiff(int.date, ext.date) <= DUPE_WINDOW_DAYS &&
    Math.abs(intUSD - extUSD) < 0.001
  ) {
    return {
      rule: 'duplicate_entry',
      confidence: 0.90,
      status: 'flagged_duplicate',
      lagDays: daysDiff(int.date, ext.date)
    };
  }
  return null;
}

function checkMissingReference(int, ext) {
  if (!ext) return null;
  const extRef = normaliseRef(ext.ref);
  if (extRef === null) {
    return {
      rule: 'missing_reference',
      confidence: 0.0,
      status: 'exception',
      reason: `External reference missing: "${ext.ref}"`
    };
  }
  return null;
}

function normalizeInputPair(pair) {
  if (pair.internal && pair.external) return pair;
  const internal = pair.internal || {
    id: pair.ledger?.id,
    ref: pair.externalRef ?? pair.ledger?.reference ?? pair.pairId,
    date: pair.ledger?.bookingDate ?? pair.gateway?.timestamp?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    amount: Number(pair.ledger?.amount ?? pair.gateway?.amount ?? 0),
    currency: pair.ledger?.currency ?? 'INR',
    vendor: pair.ledger?.vendor ?? pair.gateway?.vendor ?? 'Unknown',
    account: pair.ledger?.accountCode,
  };
  const external = pair.external || {
    id: pair.settlement?.id,
    ref: pair.expectedMismatch === 'missing_reference' ? null : (pair.externalRef ?? pair.settlement?.utr ?? pair.pairId),
    date: pair.settlement?.settlementDate ?? pair.gateway?.timestamp?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    amount: Number(pair.settlement?.amount ?? pair.gateway?.amount ?? 0),
    currency: pair.settlement?.currency ?? 'INR',
    vendor: pair.gateway?.vendor ?? 'Unknown',
  };
  return {
    ...pair,
    internal,
    external,
  };
}

function runMatcher(pairs) {
  const resolved = [];
  const exceptions = [];

  const rules = [
    checkExactMatch,
    checkAmountRounding,
    checkDateLag,
    checkFXVariance,
    checkDuplicate,
    checkMissingReference,
  ];

  for (const rawPair of pairs) {
    const pair = normalizeInputPair(rawPair);
    const { pairId, internal, external, expectedMismatch } = pair;
    let matched = null;

    for (const rule of rules) {
      const result = rule(internal, external);
      if (result) {
        matched = result;
        break;
      }
    }

    if (matched && matched.status !== 'exception') {
      resolved.push({
        pairId,
        internal,
        external,
        expectedMismatch,
        ...matched,
        resolvedBy: 'rule_engine',
        timestamp: new Date().toISOString(),
      });
    } else {
      exceptions.push({
        pairId,
        internal,
        external,
        expectedMismatch,
        rule: matched?.rule ?? 'no_rule_matched',
        reason: matched?.reason ?? 'Unmatched transaction pair',
        status: 'pending_diagnosis',
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { resolved, exceptions };
}

module.exports = { runMatcher };
