// The minimal, pino-compatible logger the store depends on, so the module never imports the host app's
// logger. Default is silent (noopLogger); the host injects its logger ONCE at startup via setStoreLogger
// (pino satisfies the Logger shape structurally). `storeLog(module)` resolves the injected root at CALL time,
// so a store constructed before setStoreLogger still logs correctly after the host wires it.

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
};

let _root: Logger = noopLogger;

/** Inject the host application's logger (pino satisfies Logger structurally). Call once at startup. */
export function setStoreLogger(logger: Logger): void {
  _root = logger;
}

/** A logger bound to `{ module }`, resolving the injected root at call time (order-independent). */
export function storeLog(module: string): Logger {
  return {
    child: (bindings) => _root.child({ module, ...bindings }),
    debug: (obj, msg) => _root.child({ module }).debug(obj, msg),
    info: (obj, msg) => _root.child({ module }).info(obj, msg),
    warn: (obj, msg) => _root.child({ module }).warn(obj, msg),
  };
}
