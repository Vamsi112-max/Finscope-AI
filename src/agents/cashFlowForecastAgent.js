'use strict';

const FLOOR_BALANCE = parseFloat(process.env.CASH_FLOOR ?? '500000');
const PROJECTION_DAYS = 14;

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return '2024-09-02';
}

function runCashFlowForecast(transactions) {
  const startedAt = new Date().toISOString();
  const todayStr = today();

  const lagDist = { T1: 0, T2: 0, T3plus: 0 };
  const settlementsByDate = {};

  transactions.forEach(t => {
    const gwDate = t.gateway?.timestamp?.slice(0, 10);
    const setDate = t.settlement?.settlementDate;
    const amount = t.settlement?.amount ?? 0;

    if (!gwDate || !setDate) return;

    const lag = daysBetween(gwDate, setDate);
    if (lag <= 1) lagDist.T1++;
    else if (lag <= 2) lagDist.T2++;
    else lagDist.T3plus++;

    if (setDate >= todayStr) {
      settlementsByDate[setDate] = (settlementsByDate[setDate] ?? 0) + amount;
    }
  });

  const dowNet = [0, 0, 0, 0, 0, 0, 0];
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  transactions.forEach(t => {
    const setDate = t.settlement?.settlementDate;
    const amount = t.settlement?.amount ?? 0;
    if (!setDate) return;
    const dow = new Date(setDate).getDay();
    dowNet[dow] += amount;
    dowCount[dow] += 1;
  });
  const dowAvg = dowNet.map((s, i) => (dowCount[i] ? s / dowCount[i] : 0));
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const settled = transactions
    .filter(t => t.settlement?.settlementDate && t.settlement.settlementDate < todayStr)
    .reduce((s, t) => s + (t.settlement?.amount ?? 0), 0);

  let runningBalance = Math.max(settled * 0.15, FLOOR_BALANCE * 2);

  const projectedBalance = [];
  const shortfallDays = [];

  for (let d = 0; d < PROJECTION_DAYS; d++) {
    const dateStr = addDays(todayStr, d);
    const dow = new Date(dateStr).getDay();
    const directFlow = settlementsByDate[dateStr] ?? 0;
    const baselineFlow = dowAvg[dow] * 0.4;
    const dailyNet = directFlow + baselineFlow;

    runningBalance += dailyNet;

    const projected = parseFloat(runningBalance.toFixed(2));
    projectedBalance.push({
      date: dateStr,
      balance: projected,
      netFlow: parseFloat(dailyNet.toFixed(2)),
      isToday: d === 0,
      dow: DOW_LABELS[dow],
    });

    if (projected < FLOOR_BALANCE) {
      shortfallDays.push({ date: dateStr, deficit: FLOOR_BALANCE - projected });
    }
  }

  const pendingSettlements = transactions.filter(t =>
    t.settlement?.status === 'pending' || !t.settlement?.settlementDate
  );
  const pendingValue = pendingSettlements.reduce((s, t) => s + Math.abs(t.settlement?.amount ?? t.gateway?.amount ?? 0), 0);

  const lagTotal = lagDist.T1 + lagDist.T2 + lagDist.T3plus || 1;
  const lagPct = {
    T1: parseFloat((lagDist.T1 / lagTotal * 100).toFixed(1)),
    T2: parseFloat((lagDist.T2 / lagTotal * 100).toFixed(1)),
    T3plus: parseFloat((lagDist.T3plus / lagTotal * 100).toFixed(1)),
  };

  return {
    agent: 'cash_flow_forecast',
    runAt: startedAt,
    today: todayStr,
    floor: FLOOR_BALANCE,
    projectionDays: PROJECTION_DAYS,
    projectedBalance,
    shortfallDays,
    hasShortfall: shortfallDays.length > 0,
    pendingSettlements: pendingSettlements.length,
    pendingValue: parseFloat(pendingValue.toFixed(2)),
    lagDistribution: { counts: lagDist, pct: lagPct },
    weekdayPattern: DOW_LABELS.map((label, i) => ({ label, avg: parseFloat(dowAvg[i].toFixed(2)) })),
    peakDay: projectedBalance.reduce((mx, d) => d.balance > mx.balance ? d : mx, projectedBalance[0]),
    troughDay: projectedBalance.reduce((mn, d) => d.balance < mn.balance ? d : mn, projectedBalance[0]),
  };
}

module.exports = { runCashFlowForecast };
