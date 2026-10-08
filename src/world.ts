// What must hold of every state the operations can reach, though no single
// guard says it: a property the guards of several operations keep together.
// A world declares the state its operations share (a purchase order and its
// receipts, say), the states it starts from, the operations that move it,
// and its invariants, kept apart from the state's type: the type says what a
// state may hold, an invariant what a reachable state does hold. `explore`
// walks at random from the starting states, one operation after another, and
// checks every invariant at each state it reaches. It samples; a walk that
// finds nothing is evidence, not a proof.
import type { AnyImplementation } from "./behavior.js";
import { perform, SpecificationError, TodoDecision } from "./behavior.js";
import { constantsOf, domainOf, integralBounds } from "./domain.js";
import { formatTypeScriptValue } from "./codegen.js";
import { deepEqual } from "./equal.js";
import { interpret, nodeOf } from "./model.js";
import type { Condition, Rule, TermOf } from "./rule.js";
import { holds, rootTerm, selfTerm } from "./rule.js";
import { object } from "./schema.js";
import { externalsIn, positiveLimit } from "./specification.js";
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

// A condition over the state, written with the term operators as a guard is
// (`state.lines.$all(line => line.received.$lte(line.quantity))`), or a model
// expression answering a boolean, for what needs `fold`, `bind` or date
// arithmetic to say.
type Check = (Rule & Condition) | Rule | unknown;

export interface Invariant {
  readonly kind: "invariant";
  readonly name: string;
  readonly holds: unknown;
}

export interface Transition {
  readonly kind: "transition";
  readonly name: string;
  readonly holds: unknown;
  // When the condition relates one record before and after, the field of
  // the state holding the records and the field of a record naming it.
  readonly each?: { readonly path: readonly string[]; readonly by?: string };
}

// Holds of every state the world reaches.
export function invariant<T>(name: string, condition: (state: TermOf<T>) => Check): Invariant {
  return { kind: "invariant", name, holds: condition(selfTerm<T>()) };
}

// Holds between the state before an operation and the state after it, as
// an action property `[][P]_vars` of TLA+ does: a step that leaves the state
// as it was is not held to it. With `each`, the condition relates one record
// before and after: the records at the field `each` names (a dotted path),
// an array matched by the field `by`, or a record matched by its keys, are
// paired by what names them, and each pair that changed is held to it; a
// record only before or only after is not paired, and a state holding two
// records with one key breaks it, since they cannot be paired.
export function transition<T>(name: string, condition: (before: TermOf<T>, after: TermOf<T>) => Check): Transition;
export function transition<E>(
  name: string,
  each: { readonly each: string; readonly by?: string },
  condition: (before: TermOf<E>, after: TermOf<E>) => Check,
): Transition;
export function transition(
  name: string,
  second: { readonly each: string; readonly by?: string } | ((before: never, after: never) => Check),
  third?: (before: never, after: never) => Check,
): Transition {
  const condition = (typeof second === "function" ? second : third)!;
  const holds = condition(rootTerm("before") as never, rootTerm("after") as never);
  if (typeof second === "function") return { kind: "transition", name, holds };
  if (second.each.length === 0) throw new SpecificationError(`Transition ${name} names no field to pair records in`);
  return { kind: "transition", name, holds, each: { path: second.each.split("."), ...(second.by === undefined ? {} : { by: second.by }) } };
}

// What `input` is handed to draw the rest of an operation's input with.
export interface Draw {
  // One of the values, or undefined when there are none.
  pick<V>(values: readonly V[]): V | undefined;
  // An integer from min to max, both included; there must be one.
  int(min: number, max: number): number;
  // A value the schema takes, drawn as `explore` draws inputs, or undefined.
  value<V>(schema: Schema<V>): V | undefined;
}

// An operation over the whole world, taking the state at the input field
// `state` names and answering the next one at the same field of its result
// (an answer without it, a refusal, leaves the state as it was, while one
// holding it, even as null, is checked as the next state); the rest of
// its input is drawn at random. Or an operation over a part of the world,
// such as one purchase order, with `input` building its input from the state
// (undefined when it has nothing to act on) and `next` placing its answer
// back in the world.
export type Operation<T> =
  | { readonly implementation: AnyImplementation; readonly state: string; readonly deps?: unknown; readonly name?: string }
  | {
      readonly implementation: AnyImplementation;
      readonly input: (state: T, draw: Draw) => unknown;
      readonly next: (state: T, execution: { readonly result: unknown; readonly effects: readonly unknown[] }, input: unknown) => T;
      readonly deps?: unknown;
      readonly name?: string;
    };

export interface World<T = unknown> {
  readonly kind: "world";
  readonly name: string;
  readonly state: Schema<T>;
  readonly initial: readonly T[];
  readonly operations: readonly Operation<T>[];
  readonly invariants: readonly Invariant[];
  readonly transitions: readonly Transition[];
}

export function world<T>(
  name: string,
  declaration: {
    readonly state: Schema<T>;
    readonly initial: readonly T[];
    readonly operations: readonly Operation<T>[];
    readonly invariants?: readonly Invariant[];
    readonly transitions?: readonly Transition[];
  },
): World<T> {
  if (declaration.initial.length === 0) throw new SpecificationError(`World ${name} starts from no state`);
  if (declaration.operations.length === 0) throw new SpecificationError(`World ${name} names no operation`);
  const invariants = declaration.invariants ?? [];
  const transitions = declaration.transitions ?? [];
  if (invariants.length + transitions.length === 0) throw new SpecificationError(`World ${name} states no invariant`);
  const names = [...invariants, ...transitions].map(item => item.name);
  const repeated = names.find((item, index) => names.indexOf(item) !== index);
  if (repeated !== undefined) throw new SpecificationError(`World ${name} names invariant ${repeated} more than once`);
  for (const item of transitions) {
    if (item.each !== undefined) pairable(name, declaration.state as AnySchema, item);
  }
  for (const operation of declaration.operations) {
    if (!("state" in operation)) continue;
    const input = operation.implementation.behavior.input;
    if (!input.variantTags.some(tag => Object.hasOwn(input.variants[tag]!.shape, operation.state))) {
      throw new SpecificationError(
        `${operation.implementation.behavior.name} takes no ${operation.state} in any input case, so it cannot be handed the state`,
      );
    }
  }
  const initial = declaration.initial.map((state, index) => {
    const parsed = declaration.state.parse(state);
    if (!parsed.success) {
      throw new SpecificationError(`World ${name} starting state ${index + 1} is not a state: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
    return parsed.value;
  });
  return { kind: "world", name, state: declaration.state, initial, operations: declaration.operations, invariants, transitions };
}

export interface ExploredStep {
  readonly operation: string;
  readonly input: unknown;
  readonly before: unknown;
  readonly result?: unknown;
  readonly after?: unknown;
}

export interface ExploreReport {
  readonly world: string;
  // `undetermined` when nothing broke but an operation never ran (it had
  // nothing to act on, or no input of it took the state), or was reached
  // where it is still `todo` or implemented outside Chisel.
  readonly status: "held" | "broken" | "undetermined";
  readonly runs: number;
  readonly steps: number;
  readonly seed: number;
  // How often each operation ran, how often it moved the state, how often it
  // had nothing to act on, and how often it was reached where it could not be run.
  readonly operations: readonly {
    readonly name: string;
    readonly ran: number;
    readonly moved: number;
    readonly skipped: number;
    readonly pending: number;
  }[];
  readonly counterexample?: {
    // The invariant or transition broken, or undefined when an operation failed.
    readonly invariant?: string;
    readonly reason: string;
    readonly start: unknown;
    readonly steps: readonly ExploredStep[];
  };
  readonly reason?: string;
}

export async function explore<T>(
  declaration: World<T>,
  options: { readonly runs?: number; readonly steps?: number; readonly seed?: number } = {},
): Promise<ExploreReport> {
  const runs = positiveLimit("runs", options.runs, 100);
  const length = positiveLimit("steps", options.steps, 20);
  const seed = options.seed ?? 1;
  // The random source reads a seed as 32 unsigned bits, so any other number
  // would draw the walks of another seed while the report shows its own.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new SpecificationError(`seed must be an integer from 0 to 4294967295, but was ${seed}`);
  }
  const main = mulberry32(seed);
  const tally = declaration.operations.map(operation => ({ name: operation.name ?? operation.implementation.behavior.name, ran: 0, moved: 0, skipped: 0, pending: 0 }));
  // Why an operation could not be run where it was reached, by its index.
  const unrun = new Map<number, string>();
  // Every starting state is checked before any walk: they are declared, not
  // drawn, so a walk choosing among them at random must not leave one unchecked.
  for (const start of declaration.initial) {
    const broken = declaration.invariants.find(item => !checks(item.holds, start));
    if (broken) {
      return {
        world: declaration.name, status: "broken", runs: 0, steps: 0, seed, operations: tally,
        counterexample: { invariant: broken.name, reason: `The starting state does not hold ${broken.name}`, start, steps: [] },
      };
    }
  }
  let total = 0;
  for (let run = 0; run < runs; run++) {
    const start: T = declaration.initial[Math.floor(main() * declaration.initial.length)]!;
    // Each step records the operation it chose and the random numbers it drew,
    // so that a walk can be replayed, and shortened, step by step.
    const plans: Plan[] = [];
    const outcome = await walk(declaration, start, length, step => {
      const plan: Plan = { index: Math.floor(main() * declaration.operations.length), tape: [] };
      plans[step] = plan;
      return { index: plan.index, random: () => { const value = main(); plan.tape.push(value); return value; } };
    }, {
      ran: (index, moved) => { tally[index]!.ran++; total++; if (moved) tally[index]!.moved++; },
      skipped: index => { tally[index]!.skipped++; },
      pending: (index, why) => { tally[index]!.pending++; unrun.set(index, why); },
    });
    if (outcome.broken) {
      const shortest = await shorten(declaration, start, plans.slice(0, outcome.steps.length), outcome);
      return {
        world: declaration.name, status: "broken", runs: run + 1, steps: total, seed, operations: tally,
        counterexample: { ...(shortest.invariant === undefined ? {} : { invariant: shortest.invariant }), reason: shortest.reason, start, steps: shortest.steps },
      };
    }
  }
  const report = { world: declaration.name, runs, steps: total, seed, operations: tally };
  const reasons = tally.flatMap((operation, index) =>
    operation.pending > 0 ? [`${operation.name} could not be run: ${unrun.get(index)}`]
    : operation.ran === 0 && operation.skipped > 0 ? [`${operation.name} never ran: it had nothing to act on in any state reached`]
    // Too few steps for the random choice to reach every operation.
    : operation.ran === 0 ? [`${operation.name} never ran: no step chose it in ${runs * length} ${runs * length === 1 ? "step" : "steps"}`]
    : []);
  return reasons.length > 0 ? { ...report, status: "undetermined", reason: reasons.join("; ") } : { ...report, status: "held" };
}

interface Plan {
  readonly index: number;
  readonly tape: number[];
}

type Walked =
  | { readonly broken: false; readonly steps: readonly ExploredStep[] }
  | { readonly broken: true; readonly invariant?: string; readonly reason: string; readonly steps: readonly ExploredStep[] };

// Runs up to `length` steps from the state, each with the operation and the
// random source `choose` gives it, and stops at the first broken invariant.
// A step whose operation has nothing to act on is skipped but still counted
// as a step of the walk, so that a replayed walk keeps its steps aligned.
async function walk<T>(
  declaration: World<T>,
  start: T,
  length: number,
  choose: (step: number) => { readonly index: number; readonly random: () => number },
  seen: {
    readonly ran?: (index: number, moved: boolean) => void;
    readonly skipped?: (index: number) => void;
    readonly pending?: (index: number, why: string) => void;
  } = {},
): Promise<Walked> {
  const steps: ExploredStep[] = [];
  let state = start;
  for (let step = 0; step < length; step++) {
    const { index, random } = choose(step);
    const operation = declaration.operations[index]!;
    const name = operation.name ?? operation.implementation.behavior.name;
    const constants = declaration.operations.flatMap(item => constantsOf(guardsOf(item.implementation)));
    const draw: Draw = {
      pick: values => (values.length === 0 ? undefined : values[Math.floor(random() * values.length)]),
      int: (min, max) => {
        // Bounds that are not integers are narrowed to the integers between them,
        // so `int(1, 2.5)` never answers 3.
        const low = Math.ceil(min), high = Math.floor(max);
        if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) throw new SpecificationError(`draw.int has no integer from ${min} to ${max}`);
        return low + Math.floor(random() * (high - low + 1));
      },
      value: schema => sampler(schema as AnySchema, constants, random)() as never,
    };
    const externals = externalsIn(operation.implementation);
    if (externals.length > 0) {
      seen.pending?.(index, `implemented outside Chisel (${externals.join(", ")})`);
      steps.push({ operation: name, input: undefined, before: state, after: state });
      continue;
    }
    // The callbacks are handed a copy, so one that changes the state in place
    // leaves the state before the step, and the starting state, as they were.
    // `input` and `next` share it, so `next` can find what `input` picked.
    const handed = copyOf(state);
    const input = "state" in operation ? inputFor(operation, handed, constants, random) : operation.input(handed, draw);
    if (input === undefined) {
      seen.skipped?.(index);
      steps.push({ operation: name, input: undefined, before: state, after: state });
      continue;
    }
    const before = state;
    let execution: { readonly result: unknown; readonly effects: readonly unknown[] };
    try {
      execution = await perform(operation.implementation, input as never, operation.deps as never);
    } catch (error) {
      // A case still todo is unfinished work, not a state the invariants refuse.
      if (error instanceof TodoDecision) {
        seen.pending?.(index, error.message);
        steps.push({ operation: name, input: undefined, before, after: before });
        continue;
      }
      seen.ran?.(index, false);
      steps.push({ operation: name, input, before });
      return { broken: true, reason: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, steps };
    }
    const after: unknown = "state" in operation ? stateIn(execution.result, operation.state, before) : operation.next(handed, execution, input);
    steps.push({ operation: name, input, before, result: execution.result, after });
    const parsed = declaration.state.parse(after);
    // Moved as the transitions see it: the state the schema reads, so an
    // optional field written as undefined does not count as a change.
    seen.ran?.(index, !parsed.success || !deepEqual(parsed.value, before));
    if (!parsed.success) {
      return { broken: true, reason: `${name} left a value that is not a state: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`, steps };
    }
    const brokenInvariant = declaration.invariants.find(item => !checks(item.holds, parsed.value));
    if (brokenInvariant) return { broken: true, invariant: brokenInvariant.name, reason: `${name} reached a state that does not hold ${brokenInvariant.name}`, steps };
    for (const item of declaration.transitions) {
      const refused = refusedBy(item, name, before, parsed.value);
      if (refused !== undefined) return { broken: true, invariant: item.name, reason: refused, steps };
    }
    state = parsed.value;
  }
  return { broken: false, steps };
}

// Drops one step at a time, replaying the rest with the random numbers each
// step drew, and keeps a drop when the shorter walk still breaks the same
// invariant (or fails the same operation). Skipped steps are dropped too.
async function shorten<T>(declaration: World<T>, start: T, plans: readonly Plan[], found: Extract<Walked, { broken: true }>): Promise<Extract<Walked, { broken: true }>> {
  const same = (walked: Walked): walked is Extract<Walked, { broken: true }> =>
    walked.broken && walked.invariant === found.invariant && (found.invariant !== undefined || walked.reason === found.reason);
  const replay = (kept: readonly Plan[]) =>
    walk(declaration, start, kept.length, step => {
      const tape = kept[step]!.tape;
      let next = 0;
      return { index: kept[step]!.index, random: () => (next < tape.length ? tape[next++]! : 0) };
    });
  let kept = [...plans];
  let shortest = found;
  for (let index = kept.length - 1; index >= 0; index--) {
    const candidate = [...kept.slice(0, index), ...kept.slice(index + 1)];
    const walked = await replay(candidate);
    if (same(walked)) {
      kept = candidate.slice(0, walked.steps.length);
      shortest = walked;
      index = Math.min(index, kept.length);
    }
  }
  return { ...shortest, steps: shortest.steps.filter(step => step.input !== undefined) };
}

// Why the step breaks the transition (it moved "the state", or one record
// named by its key, in a way the transition does not allow, or left two
// records with one key, which cannot be paired), or undefined when it allows
// the step. A pair that did not change is not held to it.
function refusedBy(item: Transition, operation: string, before: unknown, after: unknown): string | undefined {
  if (deepEqual(before, after)) return undefined;
  const moved = (what: string) => `${operation} moved ${what} in a way ${item.name} does not allow`;
  if (item.each === undefined) return checks(item.holds, { before, after }) ? undefined : moved("the state");
  const earlier = recordsAt(item, before), later = recordsAt(item, after);
  const repeated = repeatedKey(earlier) ?? repeatedKey(later);
  if (repeated !== undefined) {
    return `${operation} moved a state where ${item.each.path.join(".")} holds two records named ${labelOf(repeated.key)}, so ${item.name} cannot pair them`;
  }
  for (const [key, was] of earlier) {
    const pair = later.find(([other]) => deepEqual(other, key));
    if (pair === undefined) continue;
    const is = pair[1];
    if (deepEqual(was, is)) continue;
    if (!checks(item.holds, { before: was, after: is })) return moved(`${item.each.path.join(".")} ${labelOf(key)}`);
  }
  return undefined;
}

// The first key two of the records share, compared as values, so that two
// distinct keys that are objects are not taken as one.
function repeatedKey(records: readonly (readonly [unknown, unknown])[]): { readonly key: unknown } | undefined {
  for (let index = 0; index < records.length; index++) {
    if (records.slice(0, index).some(([key]) => deepEqual(key, records[index]![0]))) return { key: records[index]![0] };
  }
  return undefined;
}

// A key as the report names it, on one line.
function labelOf(key: unknown): string {
  return typeof key === "string" ? key : formatTypeScriptValue(key).replace(/,\n\s*([}\]])/g, " $1").replace(/\n\s*/g, " ");
}

// Refuses a transition whose records the state does not hold where it looks,
// or does not name by its field `by`: a misspelt path or field would leave
// every step with no pair, and the transition would hold of every walk.
function pairable(world: string, state: AnySchema, item: Transition): void {
  const each = item.each!;
  const unwrap = (schemas: readonly AnySchema[]): AnySchema[] =>
    schemas.map(schema => (schema.kind === "optional" ? (schema as unknown as { schema: AnySchema }).schema : schema));
  const fieldsOf = (schema: AnySchema, key: string): AnySchema[] =>
    schema.kind === "object" ? (Object.hasOwn((schema as unknown as { shape: object }).shape, key) ? [(schema as unknown as { shape: Record<string, AnySchema> }).shape[key]!] : [])
    : schema.kind === "variants" ? Object.values((schema as unknown as { variants: Record<string, AnySchema> }).variants).flatMap(variant => fieldsOf(variant, key))
    : [];
  let schemas = [state];
  for (const key of each.path) schemas = unwrap(schemas).flatMap(schema => fieldsOf(schema, key));
  const records = unwrap(schemas).filter(schema => schema.kind === "array" || schema.kind === "record");
  const at = each.path.join(".");
  if (records.length === 0) throw new SpecificationError(`World ${world}: transition ${item.name} pairs records at ${at}, where the state holds no array or record`);
  if (each.by === undefined) return;
  const by = each.by;
  const named = unwrap(records.map(schema => (schema as unknown as { element?: AnySchema; value?: AnySchema }).element ?? (schema as unknown as { value: AnySchema }).value))
    .some(schema => fieldsOf(schema, by).length > 0 || (schema.kind === "variants" && (schema as unknown as { discriminant: string }).discriminant === by));
  if (!named) throw new SpecificationError(`World ${world}: transition ${item.name} pairs the records at ${at} by ${by}, which they do not declare`);
}

// The records at the transition's field, each with what names it.
function recordsAt(item: Transition, state: unknown): (readonly [unknown, unknown])[] {
  const each = item.each!;
  let value: unknown = state;
  for (const key of each.path) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  const records: (readonly [unknown, unknown])[] = [];
  if (Array.isArray(value)) {
    if (each.by === undefined) throw new SpecificationError(`Transition ${item.name} pairs the elements of ${each.path.join(".")} but names no field to match them by`);
    for (const element of value) {
      const key = typeof element === "object" && element !== null ? (element as Record<string, unknown>)[each.by] : undefined;
      if (key !== undefined) records.push([key, element]);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) records.push([each.by === undefined ? key : ((entry as Record<string, unknown>)?.[each.by] ?? key), entry]);
  }
  return records;
}

const RULE_KINDS = new Set(["compare", "all", "any", "and", "or", "not"]);

// A rule is read as a guard reads it; anything else is evaluated as a model
// expression and must answer a boolean.
function checks(condition: unknown, scope: unknown): boolean {
  if (typeof condition === "object" && condition !== null && nodeOf(condition) === undefined && RULE_KINDS.has((condition as { kind?: string }).kind ?? "")) {
    return holds(condition as Rule, scope);
  }
  const value = interpret(condition, scope);
  if (typeof value !== "boolean") throw new SpecificationError("An invariant answers a boolean");
  return value;
}

// An input for an operation over the whole world: a random case that takes
// the state, the state at its field and random values elsewhere. The state's
// field is left out of what is drawn, so a draw of it the case would refuse
// does not refuse the input.
function inputFor(operation: { readonly implementation: AnyImplementation; readonly state: string }, state: unknown, constants: readonly unknown[], random: () => number): unknown {
  const schema = operation.implementation.behavior.input;
  // Only the cases whose field takes the state: drawing the rest of an input
  // a case would refuse for its state alone could never succeed.
  const tags = schema.variantTags.filter(tag => {
    const shape = schema.variants[tag]!.shape;
    return Object.hasOwn(shape, operation.state) && shape[operation.state]!.parse(state).success;
  });
  if (tags.length === 0) return undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const tag = tags[Math.floor(random() * tags.length)]!;
    const { [operation.state]: _, ...others } = schema.variants[tag]!.shape;
    const rest = sampler(object(others), constants, random)();
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

// A copy of a state whose objects and arrays can be changed without touching
// the original. Decimal, Rational and Temporal values cannot be changed in
// place, so they are shared rather than copied.
function copyOf<V>(value: V): V {
  if (Array.isArray(value)) return value.map(copyOf) as V;
  if (value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyOf(child)])) as V;
  }
  return value;
}

// The state at the result's field, or the state before when the field is
// absent; present, even as null, it is the next state.
function stateIn(result: unknown, field: string, before: unknown): unknown {
  return typeof result === "object" && result !== null && Object.hasOwn(result, field) ? (result as Record<string, unknown>)[field] : before;
}

const ATTEMPTS = 200;
const CANDIDATES = 64;
const MAX_LENGTH = 8;

// Draws values of a schema at random, each leaf from the values Chisel would
// try for it (its bounds, its borders, the constants the operations compare
// with), integers also between them, arrays and records at any length their
// bounds allow up to MAX_LENGTH past the lower one, and keeps the first draw
// the whole schema takes.
function sampler(schema: AnySchema, constants: readonly unknown[], random: () => number): () => unknown {
  const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)]!;
  const lengthIn = (current: AnySchema) => {
    const bounds = integralBounds(current, "length");
    const upper = Math.min(bounds.upper ?? Infinity, bounds.lower + MAX_LENGTH);
    return bounds.lower + Math.floor(random() * (upper - bounds.lower + 1));
  };
  const leaves = new Map<AnySchema, readonly unknown[]>();
  function draw(current: AnySchema): unknown {
    switch (current.kind) {
      case "object": {
        const value: Record<string, unknown> = {};
        for (const [key, field] of Object.entries((current as ObjectSchema<ObjectShape>).shape)) {
          const drawn = draw(field);
          if (drawn !== undefined) value[key] = drawn;
        }
        return value;
      }
      case "variants": {
        const sum = current as AnyVariantsSchema;
        // A sum with no case holds no value.
        if (sum.variantTags.length === 0) return undefined;
        const tag = pick(sum.variantTags);
        return { [sum.discriminant]: tag, ...(draw(sum.variants[tag]!) as object) };
      }
      case "optional":
        return random() < 0.2 ? undefined : draw((current as OptionalSchema<unknown>).schema);
      case "array": {
        const element = (current as ArraySchema<unknown>).element;
        return Array.from({ length: lengthIn(current) }, () => draw(element));
      }
      case "record": {
        const value = (current as RecordSchema<unknown>).value;
        return Object.fromEntries(Array.from({ length: lengthIn(current) }, (_, index) => [`key${index}`, draw(value)]));
      }
    }
    let values = leaves.get(current);
    if (values === undefined) {
      values = domainOf(current, CANDIDATES, constants).values;
      leaves.set(current, values);
    }
    if (values.length === 0) return current.placeholder();
    if (current.kind === "integer" && random() < 0.3) {
      const numbers = values.filter((value): value is number => typeof value === "number");
      const low = Math.min(...numbers), high = Math.max(...numbers);
      return low + Math.floor(random() * (high - low + 1));
    }
    return pick(values);
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
