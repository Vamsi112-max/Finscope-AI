# FinScope — Real-Time Payment Reconciliation Engine

A high-throughput financial reconciliation and anomaly surveillance service designed for high-volume payment processing rails. FinScope reconciles multi-layer ledger data (gateway transactions, bank clearing records, and internal accounts) in real time to catch discrepancies before settlement finality.

## Architecture

FinScope uses a deterministic-first architecture:
- **High-speed rule matching**: Automatically resolves exact matches, normal date lags, currency tolerances, and minor rounding variations with zero external overhead.
- **Exception triage**: Unmatched and edge-case exceptions are enriched with full transaction history and evaluated against strict confidence thresholds.
- **Safety guardrails**: Hard limits enforce value caps (e.g. ₹50,000 max auto-approval) and escalate low-confidence entries to human operators.
- **Audit trail**: Every decision and override produces an immutable JSON audit log.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` to configure your settings:
```env
PORT=3000
MAX_TRANSACTION_VALUE=50000
MIN_CONFIDENCE=0.7
```

### 3. Generate Sample Dataset
```bash
npm run generate-data
```

### 4. Start Server
```bash
npm start
```
Access the dashboard at `http://localhost:3000`.

## API Endpoints

- `GET /api/dataset` — Summary metrics of current active dataset
- `POST /api/upload-dataset` — Ingest custom transaction array (with schema validation)
- `POST /api/reset-sample-dataset` — Reset to baseline test dataset
- `POST /api/run-all` — Execute end-to-end reconciliation, anomaly detection, and cash flow projection
- `GET /api/anomalies` — View detected duplicates, retry bursts, and settlement delays
- `GET /api/forecast` — Retrieve 14-day forward liquidity model
- `POST /api/copilot` — Context-grounded assistant for transaction queries
- `GET /api/audits` — List historical run logs
- `POST /api/correction` — Submit reviewer overrides for model calibration

## Directory Structure

```
├── data/
│   ├── generate-dataset.js     # Test dataset generation utility
│   └── transactions.json       # Active transaction records
├── src/
│   ├── agents/
│   │   ├── anomalyWatchAgent.js       # Sentry for duplicate payouts & retry storms
│   │   ├── cashFlowForecastAgent.js   # 14-day liquidity projection
│   │   ├── financialCopilot.js        # Q&A interface
│   │   └── reconciliationAgent.js     # Primary multi-layer matcher
│   ├── guardrails.js           # Value cap and confidence floor enforcement
│   ├── matcher.js              # Deterministic matching rules
│   ├── orchestrator.js         # Coordinates multi-agent processing
│   ├── pipeline.js             # Pipeline execution
│   ├── server.js               # Express API and routes
│   └── trustTier.js            # Dynamic confidence calibration
├── public/
│   └── index.html              # Frontend console
└── audit/                      # Stored audit runs
```

## License
MIT
