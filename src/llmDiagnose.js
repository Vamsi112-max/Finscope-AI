'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-3-5-haiku-20241022';

const SYSTEM_PROMPT = `You are a financial reconciliation specialist.
Your task is to analyze a pair of transaction records (internal ledger vs external bank/vendor statement) and diagnose the mismatch.

Respond with ONLY a valid JSON object:
{
  "mismatchType": "<one of: exact_match | date_lag | amount_rounding | duplicate_entry | missing_reference | fx_variance | unresolvable>",
  "confidence": <float 0.0-1.0>,
  "reasoning": "<concise explanation, max 2 sentences>",
  "suggestedAction": "<one of: auto_approve | flag_for_review | escalate_to_human | reject>"
}`;

const FEW_SHOT_EXAMPLES = [
  {
    role: 'user',
    content: `Diagnose this transaction pair:
INTERNAL: { "ref": "REF-001", "date": "2024-06-10", "amount": 1250.00, "currency": "USD", "vendor": "Apex Logistics" }
EXTERNAL: { "ref": "REF-001", "date": "2024-06-13", "amount": 1250.00, "currency": "USD", "vendor": "Apex Logistics" }`
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      mismatchType: 'date_lag',
      confidence: 0.93,
      reasoning: 'Same reference, amount, currency, and vendor with 3-day timing difference.',
      suggestedAction: 'auto_approve'
    })
  },
  {
    role: 'user',
    content: `Diagnose this transaction pair:
INTERNAL: { "ref": "REF-042", "date": "2024-07-01", "amount": 8400.00, "currency": "USD", "vendor": "Delta Freight" }
EXTERNAL: { "ref": "N/A", "date": "2024-07-01", "amount": 8400.00, "currency": "USD", "vendor": "Delta Freight" }`
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      mismatchType: 'missing_reference',
      confidence: 0.72,
      reasoning: 'Amount, date, and vendor match but external reference is missing.',
      suggestedAction: 'flag_for_review'
    })
  }
];

async function diagnosePair(pair) {
  const { internal, external } = pair;

  const userMessage = `Diagnose this transaction pair:
INTERNAL: ${JSON.stringify(internal)}
EXTERNAL: ${JSON.stringify(external)}`;

  let rawResponse = '';
  let parsed = null;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        ...FEW_SHOT_EXAMPLES,
        { role: 'user', content: userMessage }
      ]
    });

    rawResponse = response.content[0]?.text ?? '';
    const clean = rawResponse.replace(/```(?:json)?/gi, '').trim();
    parsed = JSON.parse(clean);

    const required = ['mismatchType', 'confidence', 'reasoning', 'suggestedAction'];
    for (const field of required) {
      if (!(field in parsed)) throw new Error(`Missing field: ${field}`);
    }

    return { ...parsed, rawResponse, llmError: null };
  } catch (err) {
    return {
      mismatchType: 'unresolvable',
      confidence: 0.0,
      reasoning: `Diagnosis failed: ${err.message}`,
      suggestedAction: 'escalate_to_human',
      rawResponse,
      llmError: err.message
    };
  }
}

module.exports = { diagnosePair };
