'use strict';

const DUPLICATE_AMOUNT_TOLERANCE = 1.0;

function runAnomalyWatch(transactions) {
  const alerts = [];
  const startedAt = new Date().toISOString();

  const retryStorms = transactions.filter(t =>
    t.anomalySignals?.retryStorm || (t.gateway?.retryCount ?? 0) >= 4
  );
  if (retryStorms.length > 0) {
    const byVendor = {};
    retryStorms.forEach(t => {
      const v = t.gateway?.vendor ?? 'Unknown';
      byVendor[v] = (byVendor[v] || 0) + 1;
    });
    alerts.push({
      id: `ANOM-RS-${Date.now()}`,
      type: 'retry_storm',
      severity: retryStorms.length > 5 ? 'high' : 'medium',
      count: retryStorms.length,
      title: `${retryStorms.length} Retry Storm${retryStorms.length > 1 ? 's' : ''} Detected`,
      detail: `Transactions with >= 4 auth retries. Vendors: ${Object.entries(byVendor).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([v,c])=>`${v} (${c})`).join(', ')}.`,
      affectedPairIds: retryStorms.map(t => t.pairId),
      action: 'Investigate issuer connectivity for affected vendors',
    });
  }

  const dupeSuspects = transactions.filter(t => t.anomalySignals?.isDuplicateSuspect);
  if (dupeSuspects.length > 0) {
    const seen = {};
    const untaggedDupes = [];
    transactions.forEach(t => {
      const key = `${t.gateway?.vendor}|${t.gateway?.amount}`;
      if (seen[key] && !t.anomalySignals?.isDuplicateSuspect) {
        untaggedDupes.push(t);
      }
      seen[key] = true;
    });

    const total = dupeSuspects.length + untaggedDupes.length;
    const totalValue = dupeSuspects.reduce((s, t) => s + (t.gateway?.amount ?? 0), 0);
    alerts.push({
      id: `ANOM-DUP-${Date.now()}`,
      type: 'duplicate_payout',
      severity: total > 5 ? 'critical' : 'high',
      count: total,
      title: `${total} Potential Duplicate Payout${total > 1 ? 's' : ''}`,
      detail: `₹${totalValue.toLocaleString('en-IN', {minimumFractionDigits:2})} at risk across ${total} suspect pairs. Duplicate vendor and amount detected.`,
      affectedPairIds: [...dupeSuspects, ...untaggedDupes].map(t => t.pairId),
      action: 'Hold settlement and verify before releasing',
    });
  }

  const refundTxns = transactions.filter(t =>
    t.anomalySignals?.refundSpike || t.isRefund || (t.settlement?.amount ?? 0) < 0
  );
  if (refundTxns.length > 0) {
    const refundTotal = refundTxns.reduce((s, t) => s + Math.abs(t.settlement?.amount ?? 0), 0);
    const refundVendors = [...new Set(refundTxns.map(t => t.gateway?.vendor))];
    alerts.push({
      id: `ANOM-RF-${Date.now()}`,
      type: 'refund_spike',
      severity: refundTxns.length > 4 ? 'high' : 'medium',
      count: refundTxns.length,
      title: `Refund Cluster: ${refundTxns.length} Refunds in Window`,
      detail: `Total refund value ₹${refundTotal.toLocaleString('en-IN', {minimumFractionDigits:2})} across ${refundVendors.length} vendor${refundVendors.length > 1 ? 's' : ''}.`,
      affectedPairIds: refundTxns.map(t => t.pairId),
      action: 'Verify refund authorizations against original transaction records',
    });
  }

  const declineDrift = transactions.filter(t =>
    t.anomalySignals?.declineRateDrift || t.gateway?.status === 'declined'
  );
  if (declineDrift.length > 0) {
    const byCode = {};
    declineDrift.forEach(t => {
      const c = t.gateway?.declineCode ?? 'UNKNOWN';
      byCode[c] = (byCode[c] || 0) + 1;
    });
    const topCode = Object.entries(byCode).sort((a,b)=>b[1]-a[1])[0];
    const byBank = {};
    declineDrift.forEach(t => { const b = t.gateway?.bank ?? 'UNKNOWN'; byBank[b] = (byBank[b]||0)+1; });
    const topBank = Object.entries(byBank).sort((a,b)=>b[1]-a[1])[0];
    alerts.push({
      id: `ANOM-DC-${Date.now()}`,
      type: 'decline_rate_drift',
      severity: declineDrift.length > 3 ? 'high' : 'medium',
      count: declineDrift.length,
      title: `Decline Rate Drift: ${declineDrift.length} Failed Auth${declineDrift.length > 1 ? 's' : ''}`,
      detail: `Top decline code: ${topCode?.[0]} (${topCode?.[1]} occurrences). Bank: ${topBank?.[0]}.`,
      affectedPairIds: declineDrift.map(t => t.pairId),
      action: 'Check bank network status and retry queue',
    });
  }

  const delays = transactions.filter(t => {
    if (!t.gateway?.timestamp || !t.settlement?.settlementDate) return false;
    const gwDate = t.gateway.timestamp.slice(0, 10);
    const setDate = t.settlement.settlementDate;
    const lagDays = (new Date(setDate) - new Date(gwDate)) / 86_400_000;
    return lagDays >= 3;
  });
  if (delays.length > 0) {
    const totalHeld = delays.reduce((s, t) => s + Math.abs(t.gateway?.amount ?? 0), 0);
    alerts.push({
      id: `ANOM-SD-${Date.now()}`,
      type: 'settlement_delay',
      severity: 'medium',
      count: delays.length,
      title: `${delays.length} Settlement${delays.length > 1 ? 's' : ''} Delayed`,
      detail: `₹${totalHeld.toLocaleString('en-IN', {minimumFractionDigits:2})} delayed beyond standard T+2 settlement SLA.`,
      affectedPairIds: delays.map(t => t.pairId),
      action: 'Escalate to clearing partner',
    });
  }

  const totalAtRisk = alerts.reduce((s, a) => s + a.count, 0);
  const riskScore = Math.min(100, Math.round(
    (retryStorms.length * 2) +
    (dupeSuspects.length * 5) +
    (refundTxns.length * 3) +
    (declineDrift.length * 4) +
    (delays.length * 2)
  ));

  return {
    agent: 'anomaly_watch',
    runAt: startedAt,
    totalScanned: transactions.length,
    alertCount: alerts.length,
    riskScore,
    riskLevel: riskScore >= 30 ? 'high' : riskScore >= 15 ? 'medium' : 'low',
    totalAtRisk,
    alerts: alerts.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    }),
  };
}

module.exports = { runAnomalyWatch };
