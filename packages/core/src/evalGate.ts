// The eval-gate ladder (design 08 M6): three composable, injectable promote-time gate tiers over the generic
// store. Tier 1 (deterministic — render/parse/schema) already ships per domain (evalPromptVersion,
// evalScaffoldVersion). This module adds Tier 2 (golden-OUTPUT comparison, fully offline) and Tier 3
// (LLM-judge, async, skipped gracefully when no provider is configured), plus a promptfoo-style declarative
// assertion set and a `buildGate` that a domain selects tiers from by config. Every gate returns a
// GateResult and plugs into `promote({ gate })`; the store never hard-depends on any LLM SDK — the judge is
// an injected function.
//
// CALIBRATION NOTE (design 08 M6 acceptance). The LLM-judge is only reproducible if it is PINNED: the caller's
// JudgeFn must target a specific, pinned model VERSION (not a moving "latest" alias) and a versioned rubric,
// so a score computed today means the same next month. Record the judge model id + rubric version alongside
// the golden set. Per repo policy the judge routes only through the cost-first matrix (Cerebras / OpenAI /
// SambaNova / Groq) — never Anthropic products. The deterministic + golden-output tiers run fully offline and
// carry no such caveat.

import type { GateResult } from "./versionedStore.js";

// ---------------------------------------------------------------------------
// Promptfoo-style declarative assertions (offline, deterministic) over a string output.
// ---------------------------------------------------------------------------
export type Assertion =
  | { type: "equals"; value: string }
  | { type: "contains"; value: string }
  | { type: "not-contains"; value: string }
  | { type: "regex"; value: string }
  | { type: "is-json" }
  | { type: "min-length"; value: number };

/** Evaluate one assertion against an output. Pure; never throws (a bad regex is reported as a failure). */
export function runAssertion(a: Assertion, output: string): { passed: boolean; message: string } {
  switch (a.type) {
    case "equals":
      return { passed: output === a.value, message: `expected output to equal ${JSON.stringify(a.value)}` };
    case "contains":
      return { passed: output.includes(a.value), message: `expected output to contain ${JSON.stringify(a.value)}` };
    case "not-contains":
      return { passed: !output.includes(a.value), message: `expected output NOT to contain ${JSON.stringify(a.value)}` };
    case "regex":
      try {
        return { passed: new RegExp(a.value).test(output), message: `expected output to match /${a.value}/` };
      } catch {
        return { passed: false, message: `invalid regex assertion /${a.value}/` };
      }
    case "is-json":
      try {
        JSON.parse(output);
        return { passed: true, message: "valid JSON" };
      } catch {
        return { passed: false, message: "expected output to be valid JSON" };
      }
    case "min-length":
      return { passed: output.length >= a.value, message: `expected output length >= ${a.value} (was ${output.length})` };
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — golden-OUTPUT comparison (offline). Render the candidate over each golden input and run its
// declarative assertions against the produced output. No LLM, no network.
// ---------------------------------------------------------------------------
export interface GoldenCase<In> {
  name?: string;
  input: In;
  assert: Assertion[];
}

export interface GoldenOutputGateOpts<T, In> {
  /** Produce the output the candidate version yields for a golden input (the domain's render fn). */
  render: (value: T, input: In) => string | Promise<string>;
  goldens: GoldenCase<In>[];
}

export function goldenOutputGate<T, In>(opts: GoldenOutputGateOpts<T, In>): (value: T) => Promise<GateResult> {
  return async (value: T): Promise<GateResult> => {
    const failures: string[] = [];
    for (let i = 0; i < opts.goldens.length; i++) {
      const g = opts.goldens[i];
      const label = g.name ?? `golden[${i}]`;
      let output: string;
      try {
        output = await opts.render(value, g.input);
      } catch (err) {
        failures.push(`${label}: render threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const a of g.assert) {
        const r = runAssertion(a, output);
        if (!r.passed) failures.push(`${label}: ${r.message}`);
      }
    }
    return { passed: failures.length === 0, failures };
  };
}

// ---------------------------------------------------------------------------
// Tier 3 — LLM-judge (async). Renders the candidate, hands the output + a rubric to an INJECTED judge that
// returns a score in [0,1]; a case fails when the score is below its threshold. Skipped gracefully (passes)
// when no provider is configured (judge === null), so a promote is never BLOCKED by an unavailable judge.
// ---------------------------------------------------------------------------
export type JudgeFn = (args: { output: string; rubric: string }) => Promise<number | null>;

export interface LlmJudgeGoldenCase<In> {
  name?: string;
  input: In;
  rubric: string;      // what "good" means for this case, handed to the judge
  threshold?: number;  // minimum score to pass (default: defaultThreshold ?? 0.7)
}

export interface LlmJudgeGateOpts<T, In> {
  render: (value: T, input: In) => string | Promise<string>;
  goldens: LlmJudgeGoldenCase<In>[];
  /** null => no provider configured => the whole tier is skipped (passes). Pin the model version (see note). */
  judge: JudgeFn | null;
  defaultThreshold?: number;
}

export function llmJudgeGate<T, In>(opts: LlmJudgeGateOpts<T, In>): (value: T) => Promise<GateResult> {
  return async (value: T): Promise<GateResult> => {
    if (opts.judge === null) return { passed: true, failures: [] }; // no provider -> skip gracefully
    const judge = opts.judge;
    const failures: string[] = [];
    for (let i = 0; i < opts.goldens.length; i++) {
      const g = opts.goldens[i];
      const label = g.name ?? `judge[${i}]`;
      const threshold = g.threshold ?? opts.defaultThreshold ?? 0.7;
      let output: string;
      try {
        output = await opts.render(value, g.input);
      } catch (err) {
        failures.push(`${label}: render threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const score = await judge({ output, rubric: g.rubric });
      if (score === null) continue; // a transient judge miss on one case does not block the promote
      if (score < threshold) failures.push(`${label}: judge score ${score.toFixed(2)} < threshold ${threshold}`);
    }
    return { passed: failures.length === 0, failures };
  };
}

// ---------------------------------------------------------------------------
// Compose tiers (AND across all) + a config-driven selector so a domain picks which of the three tiers run.
// ---------------------------------------------------------------------------
export function composeGates<T>(...gates: Array<(value: T) => GateResult | Promise<GateResult>>): (value: T) => Promise<GateResult> {
  return async (value: T): Promise<GateResult> => {
    const failures: string[] = [];
    for (const gate of gates) {
      const r = await gate(value);
      if (!r.passed) failures.push(...r.failures);
    }
    return { passed: failures.length === 0, failures };
  };
}

/** Which gate tiers a domain runs at promote (design 08 M6: "any of the three tiers selected by config"). */
export interface GateTierConfig<T, In> {
  deterministic?: (value: T) => GateResult | Promise<GateResult>; // tier 1 (e.g. evalPromptVersion)
  goldenOutput?: GoldenOutputGateOpts<T, In>;                     // tier 2
  llmJudge?: LlmJudgeGateOpts<T, In>;                             // tier 3
}

/** Assemble a single gate from the selected tiers (run in order 1 -> 2 -> 3, all must pass). */
export function buildGate<T, In>(config: GateTierConfig<T, In>): (value: T) => Promise<GateResult> {
  const gates: Array<(value: T) => GateResult | Promise<GateResult>> = [];
  if (config.deterministic) gates.push(config.deterministic);
  if (config.goldenOutput) gates.push(goldenOutputGate(config.goldenOutput));
  if (config.llmJudge) gates.push(llmJudgeGate(config.llmJudge));
  return composeGates(...gates);
}
