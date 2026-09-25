// The types and errors that cross a consumer's facade boundary, with no runtime dependency on the store.
//
// The README asks a consumer to wire the store at ONE construction site and to import from its own facade
// everywhere else. It also asks the consumer to catch our typed errors, which until now meant importing this
// package in a route handler, which is the one place the first rule forbids. A consumer following both could
// not, so one consumer followed the first rule, used none of our typed errors, flattened a gate refusal to a
// string, and shipped a dashboard that renders a refusal as one run-on line.
//
// This entry point resolves that. It carries the error classes, the brand guard, and the result and gate types,
// and it pulls in no backend, no cipher and no store construction, so it is safe to import anywhere. A facade
// should re-export what it needs from here, so its own callers never name this package at all.
//
//   import { GateRejectedError, isVersionedStoreError } from "@versioned-store/core/contract";
//   export type { GateResult, Resolved } from "@versioned-store/core/contract";

export * from "./errors.js";

export type {
  Resolved,
  VersionInfo,
  KeySummary,
  GateResult,
  Gate,
  DefaultsGate,
  DefaultCheck,
  DefaultsHealthReport,
  SeedResult,
  SyncResult,
} from "./versionedStore.js";

export type { StoreEvent, FallbackReason } from "./events.js";
export type { Logger } from "./logger.js";
