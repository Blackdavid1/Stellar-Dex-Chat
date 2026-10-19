'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ChatInput from '@/components/ChatInput';

/**
 * Structured financial fact attached to an AI answer.
 *
 * Source, observed-at time, pair, and validity window are passed as
 * application data so citations are rendered from trusted values and the
 * model can never invent source URLs.
 */
type FactStatus = 'fresh' | 'stale' | 'missing' | 'conflicting';

interface FinancialFact {
  pair: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
  validUntil: string;
  status: FactStatus;
  /** Rate is authoritative; payout is an estimate, never a guarantee. */
  rate?: number;
  estimatedPayout?: number;
}

interface SentMessage {
  text: string;
  fact?: FinancialFact;
}

const STATUS_LABEL: Record<FactStatus, string> = {
  fresh: 'Fresh data',
  stale: 'Stale data — verify before acting',
  missing: 'Data missing — no authoritative rate available',
  conflicting: 'Conflicting sources — treat as unverified',
};

/**
 * Bounded latency budgets for model requests.
 *
 * `requestMs` bounds a single model round-trip; `totalMs` bounds the whole
 * turn (including retries/streaming). Both are enforced via AbortController so
 * a slow or abandoned call can never block chat or authorize a late action.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 30_000;

/**
 * Typed recoverable state for a model request.
 *
 * `timeout` and `cancelled` are recoverable: the user's text is preserved and
 * no transaction intent is retried without renewed confirmation.
 */
type ModelRequestState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; text: string }
  | { status: 'timeout'; message: string }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string };

/** Latency metrics recorded without prompts or responses. */
interface LatencyMetric {
  outcome: 'ok' | 'timeout' | 'cancelled' | 'error';
  durationMs: number;
}

/**
 * Supported locales for locale-aware intent evaluation.
 *
 * Each entry declares representative examples for amounts, decimal/grouping
 * separators, currencies, and ambiguity cases. Language interpretation is kept
 * separate from canonical parsing and contract unit conversion so transaction
 * arithmetic stays deterministic and unchanged.
 */
type LocaleCode = 'en-US' | 'de-DE' | 'fr-FR' | 'ja-JP';

interface LocaleExample {
  /** Raw user utterance in this locale. */
  utterance: string;
  /** Canonical amount after deterministic parsing, or null if withheld. */
  canonicalAmount: number | null;
  /** ISO 4217 currency code resolved from the utterance, or null if ambiguous. */
  currency: string | null;
  /** True when the input must be withheld for clarification. */
  ambiguous: boolean;
}

interface LocaleSpec {
  code: LocaleCode;
  label: string;
  decimalSeparator: '.' | ',';
  groupingSeparator: ',' | '.' | ' ';
  examples: LocaleExample[];
}

const SUPPORTED_LOCALES: LocaleSpec[] = [
  {
    code: 'en-US',
    label: 'English (United States)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: 'swap 1,234.56 USDC to ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'send 100 dollars', canonicalAmount: 100, currency: 'USD', ambiguous: false },
      { utterance: 'swap 50 $ to ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'de-DE',
    label: 'German (Germany)',
    decimalSeparator: ',',
    groupingSeparator: '.',
    examples: [
      { utterance: 'tausche 1.234,56 USDC in ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'sende 100 Euro', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'tausche 50 $ in ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'fr-FR',
    label: 'French (France)',
    decimalSeparator: ',',
    groupingSeparator: ' ',
    examples: [
      { utterance: 'échanger 1 234,56 USDC contre ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'envoyer 100 euros', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'échanger 50 $ contre ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'ja-JP',
    label: 'Japanese (Japan)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: '1,234.56 USDC を ETH に交換', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: '100 円 を送金', canonicalAmount: 100, currency: 'JPY', ambiguous: false },
      { utterance: '50 $ を ETH に交換', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
];

/**
 * Deterministic conversation replay for incident debugging.
 *
 * A trace records versioned state transitions, tool names, normalized
 * arguments, policy decisions, and outcome codes with sensitive values
 * redacted. Replay compares a recorded trace against a pinned model/policy
 * fixture and reports divergence without executing any external or write
 * tool. Traces are retained in memory only and never persisted client-side.
 */
type PolicyDecision = 'allow' | 'deny' | 'clarify';
type OutcomeCode = 'ok' | 'denied' | 'error' | 'withheld';

interface TraceStep {
  /** Monotonic step index within the trace. */
  index: number;
  /** Versioned state transition label, e.g. "intent.parsed@v1". */
  transition: string;
  /** Tool name, or null when the step is a pure state transition. */
  tool: string | null;
  /** Normalized (redacted) tool arguments. */
  args: Record<string, string>;
  policy: PolicyDecision;
  outcome: OutcomeCode;
}

interface ConversationTrace {
  /** Trace schema version for forward-compatible replay. */
  version: 1;
  /** Pinned model/policy fixture the trace was recorded against. */
  fixture: string;
  steps: TraceStep[];
}

interface ReplayDivergence {
  index: number;
  field: 'transition' | 'tool' | 'args' | 'policy' | 'outcome';
  recorded: string;
  replayed: string;
}

const SENSITIVE_KEY = /(secret|token|key|password|seed|private|auth|signature)/i;

/** Redact sensitive argument values before they enter a trace. */
function redactArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : String(v);
  }
  return out;
}

/** Tools that must never execute during replay. */
const WRITE_TOOLS = new Set(['swap', 'send', 'approve', 'transfer', 'sign']);

/**
 * Replay a recorded trace against a pinned fixture. Pure and deterministic:
 * no network, no model calls, and no tool execution. Returns divergences.
 */
function replayTrace(
  recorded: ConversationTrace,
  fixture: ConversationTrace,
): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];
  if (recorded.fixture !== fixture.fixture) {
    divergences.push({
      index: -1,
      field: 'transition',
      recorded: recorded.fixture,
      replayed: fixture.fixture,
    });
    return divergences;
  }
  const len = Math.max(recorded.steps.length, fixture.steps.length);
  for (let i = 0; i < len; i++) {
    const a = recorded.steps[i];
    const b = fixture.steps[i];
    if (!a || !b) {
      divergences.push({
        index: i,
        field: 'transition',
        recorded: a ? a.transition : '(missing)',
        replayed: b ? b.transition : '(missing)',
      });
      continue;
    }
    if (a.transition !== b.transition) {
      divergences.push({ index: i, field: 'transition', recorded: a.transition, replayed: b.transition });
    }
    if (a.tool !== b.tool) {
      divergences.push({ index: i, field: 'tool', recorded: String(a.tool), replayed: String(b.tool) });
    }
    if (JSON.stringify(a.args) !== JSON.stringify(b.args)) {
      divergences.push({ index: i, field: 'args', recorded: JSON.stringify(a.args), replayed: JSON.stringify(b.args) });
    }
    if (a.policy !== b.policy) {
      divergences.push({ index: i, field: 'policy', recorded: a.policy, replayed: b.policy });
    }
    if (a.outcome !== b.outcome) {
      divergences.push({ index: i, field: 'outcome', recorded: a.outcome, replayed: b.outcome });
    }
  }
  return divergences;
}

const PINNED_FIXTURE = 'model-fixture@2024-06-01/policy@v3';

const SAMPLE_TRACE: ConversationTrace = {
  version: 1,
  fixture: PINNED_FIXTURE,
  steps: [
    {
      index: 0,
      transition: 'intent.parsed@v1',
      tool: null,
      args: {},
      policy: 'allow',
      outcome: 'ok',
    },
    {
      index: 1,
      transition: 'tool.routed@v1',
      tool: 'swap',
      args: redactArgs({ pair: 'USDC/ETH', amount: '1234.56', apiKey: 'sk-live-xxx' }),
      policy: 'deny',
      outcome: 'denied',
    },
  ],
};

/**
 * Test harness page for ChatInput E2E tests.
 *
 * Exposes a controlled form around ChatInput so tests can drive the input and
 * assert on submitted text. Model requests are bounded by per-request and
 * total latency budgets with cancellation propagated from the UI.
 */
export default function TestChatInputPage() {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [requestState, setRequestState] = useState<ModelRequestState>({ status: 'idle' });
  const [metrics, setMetrics] = useState<LatencyMetric[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const totalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (totalTimerRef.current) {
      clearTimeout(totalTimerRef.current);
      totalTimerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearTimers();
  }, [clearTimers]);

  useEffect(() => () => cancel(), [cancel]);

  const recordMetric = useCallback((outcome: LatencyMetric['outcome'], startedAt: number) => {
    // Latency only — never record prompts or responses.
    setMetrics((prev) => [...prev, { outcome, durationMs: Date.now() - startedAt }]);
  }, []);

  const runModelRequest = useCallback(
    async (text: string) => {
      cancel();
      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = Date.now();
      setRequestState({ status: 'pending' });

      // Total budget: abort the whole turn if it exceeds TOTAL_TIMEOUT_MS.
      totalTimerRef.current = setTimeout(() => controller.abort('total-timeout'), TOTAL_TIMEOUT_MS);

      // Per-request budget: abort a single round-trip if it exceeds REQUEST_TIMEOUT_MS.
      const requestTimer = setTimeout(() => controller.abort('request-timeout'), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        const data = (await res.json()) as { text?: string };
        // Late responses after abort must not authorize any action.
        if (controller.signal.aborted) return;
        setRequestState({ status: 'ok', text: data.text ?? '' });
        recordMetric('ok', startedAt);
      } catch (err) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          if (reason === 'request-timeout' || reason === 'total-timeout') {
            setRequestState({
              status: 'timeout',
              message: 'The model took too long. Your message was kept — resend to try again.',
            });
            recordMetric('timeout', startedAt);
          } else {
            setRequestState({
              status: 'cancelled',
              message: 'Request cancelled. Your message was kept.',
            });
            recordMetric('cancelled', startedAt);
          }
          return;
        }
        setRequestState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Request failed.',
        });
        recordMetric('error', startedAt);
      } finally {
        clearTimeout(requestTimer);
        clearTimers();
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancel, clearTimers, recordMetric],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSent((prev) => [...prev, { text: trimmed }]);
      // Preserve user text until the request resolves; clear only on success.
      setValue(trimmed);
      void runModelRequest(trimmed).then(() => {
        setRequestState((state) => {
          if (state.status === 'ok') setValue('');
          return state;
        });
      });
    },
    [runModelRequest],
  );

  const isPending = requestState.status === 'pending';

  return (
    <div>
      <ChatInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      {isPending && (
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      )}
      {(requestState.status === 'timeout' || requestState.status === 'cancelled') && (
        <p role="status">{requestState.message}</p>
      )}
      {requestState.status === 'error' && <p role="alert">{requestState.message}</p>}
      <ul>
        {sent.map((m, i) => (
          <li key={i}>{m.text}</li>
        ))}
      </ul>
      <ul aria-label="latency-metrics">
        {metrics.map((m, i) => (
          <li key={i}>{`${m.outcome}:${m.durationMs}ms`}</li>
        ))}
      </ul>
    </div>
  );
}
