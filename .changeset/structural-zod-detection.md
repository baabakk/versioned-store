---
"@versioned-store/prompt-store": patch
---

Detect var-schema fields structurally (by the schema's `.shape`) instead of `instanceof z.ZodObject`.

`instanceof` is only true when the package's zod and the consumer's zod are the same module instance, so a duplicated or version-split zod in the consumer's dependency tree silently disabled the promote-gate's unknown-placeholder check (it returned "no known fields", so every placeholder looked valid). Render-time validation was never affected, since it calls `.safeParse` on the consumer's own schema instance; this closes the gap in the gate's field enumeration. The structural check also works across zod 3 and 4. Documented the bring-your-own-zod behavior in the README.
