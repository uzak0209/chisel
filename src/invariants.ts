// Invariants of a state that several behaviors share: a record such as a
// purchase order that one behavior creates, another amends and a third
// issues. The state's schema states its invariants with `refine`, and each
// operation takes the state at a field of its input and answers the next one
// at a field of its result. `checkInvariants` runs random sequences of the
// operations from states that hold the invariants and reports the first
// sequence that ends in a state they do not hold. It samples; a run that
// finds nothing is evidence, not a proof.
import type { AnyImplementation } from "./behavior.js";
import { perform, SpecificationError } from "./behavior.js";
import { constantsOf, domainOf, integralBounds } from "./domain.js";
import type { Rule } from "./rule.js";
import type {
  AnySchema,
  AnyVariantsSchema,
  ArraySchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
  RecordSchema,
  Schema,
} from "./schema.js";

export interface InvariantOperation {
  readonly implementation: AnyImplementation;
  // The field of the input case that takes the state, and of the result that
  // answers the next state. A result without the field (a refusal) leaves the
  // state as it was.
  readonly state: string;
  readonly deps?: unknown;
}

export interface Invariants<T = unknown> {
  readonly kind: "invariants";
  readonly name: string;
  readonly state: Schema<T>;
  readonly operations: readonly InvariantOperation[];
}

export function invariants<T>(
  name: string,
  declaration: { readonly state: Schema<T>; readonly operations: readonly InvariantOperation[] },
): Invariants<T> {
  if (declaration.operations.length === 0) throw new SpecificationError(`Invariants ${name} name no operation`);
  for (const operation of declaration.operations) {
    const input = operation.implementation.behavior.input;
    if (!input.variantTags.some(tag => Object.hasOwn(input.variants[tag]!.shape, operation.state))) {
      throw new SpecificationError(
        `${operation.implementation.behavior.name} takes no ${operation.state} in any input case, so it cannot be handed the state`,
      );
    }
  }
  return { kind: "invariants", name, state: declaration.state, operations: declaration.operations };
}

export interface InvariantStep {
  readonly operation: string;
  readonly input: unknown;
  readonly before: unknown;
  readonly after?: unknown;
  readonly result?: unknown;
}

export interface InvariantReport {
  readonly name: string;
  readonly status: "held" | "broken" | "not run";
  readonly runs: number;
  readonly steps: number;
  readonly seed: number;
  // How often each operation ran, and how often it answered a next state.
  readonly operations: readonly { readonly name: string; readonly ran: number; readonly moved: number }[];
  readonly counterexample?: { readonly reason: string; readonly steps: readonly InvariantStep[] };
  readonly reason?: string;
}

export async function checkInvariants<T>(
  declaration: Invariants<T>,
  options: { readonly runs?: number; readonly steps?: number; readonly seed?: number } = {},
): Promise<InvariantReport> {
  const runs = options.runs ?? 100;
  const length = options.steps ?? 10;
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);
  const tally = declaration.operations.map(operation => ({ name: operation.implementation.behavior.name, ran: 0, moved: 0 }));
  const constants = declaration.operations.flatMap(operation => constantsOf(guardsOf(operation.implementation)));
  const stateOf = sampler(declaration.state as AnySchema, constants, random);
  let total = 0;
  const broken = (run: number, reason: string, steps: readonly InvariantStep[]): InvariantReport => ({
    name: declaration.name, status: "broken", runs: run + 1, steps: total, seed, operations: tally, counterexample: { reason, steps },
  });
  for (let run = 0; run < runs; run++) {
    let state = stateOf();
    if (state === undefined) {
      return { name: declaration.name, status: "not run", runs: run, steps: total, seed, operations: tally, reason: `No state that holds the invariants of ${declaration.name} was found` };
    }
    const steps: InvariantStep[] = [];
    for (let step = 0; step < length; step++) {
      const index = Math.floor(random() * declaration.operations.length);
      const operation = declaration.operations[index]!;
      const input = inputFor(operation, state, constants, random);
      if (input === undefined) continue;
      tally[index]!.ran++;
      total++;
      const before = state;
      let execution: { readonly result: unknown };
      try {
        execution = await perform(operation.implementation, input as never, operation.deps as never);
      } catch (error) {
        steps.push({ operation: tally[index]!.name, input, before });
        const reason = error instanceof Error ? error.message : String(error);
        return broken(run, `${tally[index]!.name} failed: ${reason}`, steps);
      }
      const answered = fieldOf(execution.result, operation.state);
      steps.push({ operation: tally[index]!.name, input, before, result: execution.result, ...(answered.present ? { after: answered.value } : {}) });
      if (!answered.present) continue;
      tally[index]!.moved++;
      const parsed = declaration.state.parse(answered.value);
      if (!parsed.success) return broken(run, `${tally[index]!.name} answered a state ${declaration.name} does not hold: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`, steps);
      state = parsed.value;
    }
  }
  return { name: declaration.name, status: "held", runs, steps: total, seed, operations: tally };
}

// An input for the operation: a random case that takes the state, the state
// at its field and random values elsewhere.
function inputFor(operation: InvariantOperation, state: unknown, constants: readonly unknown[], random: () => number): unknown {
  const schema = operation.implementation.behavior.input;
  const tags = schema.variantTags.filter(tag => Object.hasOwn(schema.variants[tag]!.shape, operation.state));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const tag = tags[Math.floor(random() * tags.length)]!;
    const rest = sampler(schema.variants[tag]!, [...constants, ...constantsOf(guardsOf(operation.implementation))], random)();
    if (rest === undefined) continue;
    const input = { [schema.discriminant]: tag, ...(rest as object), [operation.state]: state };
    if (schema.parse(input).success) return input;
  }
  return undefined;
}

function guardsOf(implementation: AnyImplementation): Rule[] {
  return Object.values(implementation.cases).flatMap(decision =>
    decision !== undefined && decision.kind === "rules" ? decision.guards.map(guard => guard.condition) : [],
  );
}

function fieldOf(value: unknown, field: string): { readonly present: boolean; readonly value?: unknown } {
  return typeof value === "object" && value !== null && Object.hasOwn(value, field)
    ? { present: true, value: (value as Record<string, unknown>)[field] }
    : { present: false };
}

const ATTEMPTS = 200;
const CANDIDATES = 64;
const MAX_LENGTH = 8;

// Draws values of a schema at random, each leaf from the values Chisel would
// try for it (its bounds, its borders, the constants the operations compare
// with), and keeps the first one the whole schema takes.
function sampler(schema: AnySchema, constants: readonly unknown[], random: () => number): () => unknown {
  const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)]!;
  const leaves = new Map<AnySchema, readonly unknown[]>();
  function draw(current: AnySchema): unknown {
    switch (current.kind) {
      case "object": {
        const shape = (current as ObjectSchema<ObjectShape>).shape;
        const value: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(shape)) {
          const drawn = draw(field);
          if (drawn !== undefined) value[key] = drawn;
        }
        return value;
      }
      case "variants": {
        const sum = current as AnyVariantsSchema;
        const tag = pick(sum.variantTags);
        return { [sum.discriminant]: tag, ...(draw(sum.variants[tag]!) as object) };
      }
      case "optional":
        return random() < 0.2 ? undefined : draw((current as OptionalSchema<unknown>).schema);
      case "array": {
        // Half the time a length Chisel would try (its bounds, 0, 1, 2), half
        // the time any length up to MAX_LENGTH past the lower bound, so that
        // several elements meet.
        const element = (current as ArraySchema<unknown>).element;
        const bounds = integralBounds(current, "length");
        const upper = Math.min(bounds.upper ?? Infinity, bounds.lower + MAX_LENGTH);
        const tried = (domainOf(current, CANDIDATES, constants).values as unknown[][]).map(items => items.length);
        const size = tried.length > 0 && random() < 0.5 ? pick(tried) : bounds.lower + Math.floor(random() * (upper - bounds.lower + 1));
        return Array.from({ length: size }, () => draw(element));
      }
      case "record": {
        // Any number of entries its length bounds allow, up to MAX_LENGTH past the lower one.
        const value = (current as RecordSchema<unknown>).value;
        const bounds = integralBounds(current, "length");
        const upper = Math.min(bounds.upper ?? Infinity, bounds.lower + MAX_LENGTH);
        const size = bounds.lower + Math.floor(random() * (upper - bounds.lower + 1));
        return Object.fromEntries(Array.from({ length: size }, (_, index) => [`key${index}`, draw(value)]));
      }
    }
    let values = leaves.get(current);
    if (values === undefined) {
      values = domainOf(current, CANDIDATES, constants).values;
      leaves.set(current, values);
    }
    if (values.length === 0) return current.placeholder();
    const chosen = pick(values);
    // An integer leaf also takes values between the ones Chisel would try.
    if (current.kind === "integer" && random() < 0.3) {
      const numbers = values.filter((value): value is number => typeof value === "number");
      const low = Math.min(...numbers), high = Math.max(...numbers);
      return low + Math.floor(random() * (high - low + 1));
    }
    return chosen;
  }
  return () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const parsed = schema.parse(draw(schema));
      if (parsed.success) return parsed.value;
    }
    return undefined;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
