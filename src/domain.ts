import { Rational, isRational, INT64_MIN, INT64_MAX } from "./exact.js";
import { Decimal } from "decimal.js";
import { deepEqual } from "./equal.js";
import type { AnySchema, AnyVariantsSchema, ArraySchema, EnumSchema, LiteralSchema, ObjectSchema, ObjectShape, OptionalSchema, RecordSchema, DecimalSchema } from "./schema.js";
import { bordersOf } from "./border.js";
import { carrierOf } from "./partition.js";
import type { Measure, Rule } from "./rule.js";
import { conjuncts, isTerm, positionData, termData, counts } from "./rule.js";

export interface Domain {
  readonly values: readonly unknown[];
  readonly exhaustive: boolean;
}

export function constantsOf(rules: readonly Rule[]): unknown[] {
  return rules.flatMap((rule): unknown[] => {
    if (rule.kind === "and" || rule.kind === "or") return constantsOf(rule.rules);
    if (rule.kind === "not") return constantsOf([rule.rule]);
    if (rule.kind === "all" || rule.kind === "any") return constantsOf([rule.each]);
    return [rule.left, rule.right].flatMap(value => !isTerm(value) ? [value] : termData(value).kind === "linear" ? [(termData(value) as { constant: unknown }).constant] : []);
  });
}

export function domainOf(schema: AnySchema, limit: number, constants: readonly unknown[] = []): Domain {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Domain limit must be a positive safe integer");
  return read(schema, new Set());

  function read(current: AnySchema, ancestors: ReadonlySet<AnySchema>): Domain {
    if (ancestors.has(current)) return { values: [], exhaustive: false };
    const parents = new Set([...ancestors, current]);
    const nested = (child: AnySchema) => read(child, parents);
    const finish = (values: readonly unknown[], exhaustive: boolean): Domain => {
      const unique: unknown[] = [];
      const buckets = new Map<string, unknown[]>();
      for (const value of values.slice(0, limit)) {
        const parsed = current.parse(value);
        if (!parsed.success) continue;
        const key = JSON.stringify(parsed.value, (_, value) => typeof value === "bigint" ? `${value}n` : value) ?? "undefined";
        const bucket = buckets.get(key) ?? [];
        if (bucket.some(other => deepEqual(other, parsed.value))) continue;
        bucket.push(parsed.value);
        buckets.set(key, bucket);
        unique.push(parsed.value);
      }
      return { values: unique, exhaustive: exhaustive && values.length <= limit };
    };
    switch (current.kind) {
      case "boolean": return finish([false, true], true);
      case "enum": return finish((current as EnumSchema<string>).values, true);
      case "literal": return finish([(current as LiteralSchema<any>).value], true);
      case "optional": {
        const child = nested((current as OptionalSchema<unknown>).schema);
        return finish([undefined, ...child.values], child.exhaustive);
      }
      case "object": {
        const fields = Object.entries((current as ObjectSchema<ObjectShape>).shape);
        const product = productOf(fields.map(([, field]) => nested(field)), limit);
        return finish(product.values.map(values => Object.fromEntries(fields.flatMap(([key], index) => values[index] === undefined ? [] : [[key, values[index]]]))), product.exhaustive);
      }
      case "variants": {
        const sum = current as AnyVariantsSchema;
        const values: unknown[] = [];
        let exhaustive = true;
        for (const tag of sum.variantTags) {
          const child = nested(sum.variants[tag]!);
          exhaustive &&= child.exhaustive;
          values.push(...child.values.map(value => ({ [sum.discriminant]: tag, ...(value as object) })));
          if (values.length > limit) { exhaustive = false; break; }
        }
        return finish(values, exhaustive);
      }
      case "array": {
        const child = nested((current as ArraySchema<unknown>).element);
        const bounds = integralBounds(current, "length");
        const lengths = [...new Set([bounds.lower, 0, 1, 2, ...constants.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0), ...(bounds.upper === undefined ? [] : [bounds.upper])])].filter(length => length >= 0 && length <= limit);
        const values: unknown[] = [];
        let exhaustive = child.exhaustive && bounds.upper !== undefined && bounds.upper <= limit;
        const sizes = exhaustive ? Array.from({ length: Math.max(0, bounds.upper! - bounds.lower + 1) }, (_, index) => bounds.lower + index) : lengths;
        for (const size of sizes) {
          const product = productOf(Array.from({ length: size }, () => child), Math.max(1, limit - values.length));
          values.push(...product.values);
          exhaustive &&= product.exhaustive;
          if (values.length >= limit) { exhaustive = false; break; }
        }
        return finish(values, exhaustive);
      }
      case "record": {
        const child = nested((current as RecordSchema<unknown>).value);
        return finish([{}, ...child.values.map(value => ({ key: value }))], integralBounds(current, "length").upper === 0);
      }
    }
    const local = [...constants, ...constantsOf(current.invariants)];
    const values: unknown[] = [];
    try { values.push(current.placeholder()); } catch {}
    let exhaustive = false;
    if (current.kind === "integer") {
      const bounds = integralBounds(current, "value");
      if (bounds.upper !== undefined && bounds.lower > -Infinity && bounds.upper - bounds.lower < limit) {
        values.push(...Array.from({ length: Math.max(0, bounds.upper - bounds.lower + 1) }, (_, index) => bounds.lower + index));
        exhaustive = true;
      }
    }
    if (current.kind === "int64") {
      let lower = INT64_MIN, upper = INT64_MAX;
      for (const rule of current.invariants.flatMap(conjuncts)) {
        if (rule.kind !== "compare" || !isTerm(rule.left) || typeof rule.right !== "bigint") continue;
        const at = positionData(rule.left);
        if (!at || at.path.length || at.measure !== "value") continue;
        const bound = rule.right;
        if ([">=", ">", "=="].includes(rule.operator)) { const next = bound + (rule.operator === ">" ? 1n : 0n); if (next > lower) lower = next; }
        if (["<=", "<", "=="].includes(rule.operator)) { const next = bound - (rule.operator === "<" ? 1n : 0n); if (next < upper) upper = next; }
      }
      if (upper - lower < BigInt(limit)) {
        for (let value = lower; value <= upper; value++) values.push(value);
        exhaustive = true;
      }
      values.push(-2n, -1n, 0n, 1n, 2n);
      for (const value of local) if (typeof value === "bigint") values.push(value, value - 1n, value + 1n);
    } else if (current.kind === "rational") {
      values.push(new Rational(-1n), new Rational(0n), new Rational(1n));
      for (const value of local) if (isRational(value)) values.push(value, value.plus(new Rational(1n)), value.minus(new Rational(1n)));
    } else if (current.kind === "integer" || current.kind === "number") {
      values.push(-2, -1, 0, 1, 2);
      for (const value of local) if (typeof value === "number" && Number.isFinite(value)) values.push(value, value - 1, value + 1, value / 2);
    } else if (current.kind === "string") {
      values.push("", "a", "😀", ...local.filter(value => typeof value === "string"));
      for (const value of local) if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < limit) values.push("_".repeat(value), "_".repeat(Math.max(0, value - 1)), "_".repeat(value + 1));
      exhaustive = integralBounds(current, "length").upper === 0;
    } else if (current.kind === "decimal") {
      const step = new Decimal(10).pow(-(current as DecimalSchema).scale);
      for (const value of local) if (Decimal.isDecimal(value) || typeof value === "number") {
        const decimal = new Decimal(value);
        values.push(decimal, decimal.plus(step), decimal.minus(step));
      }
    }
    for (const border of bordersOf(current.invariants.flatMap(conjuncts), measure => carrierOf(current, measure))) {
      for (const point of border.points) if (point.witness !== undefined) {
        values.push(counts(border.measure) && current.kind === "string" && typeof point.witness === "number" && point.witness >= 0 && point.witness <= limit ? "_".repeat(point.witness) : point.witness);
      }
    }
    return finish(values, exhaustive);
  }
}

function productOf(domains: readonly Domain[], limit: number): { values: unknown[][]; exhaustive: boolean } {
  let values: unknown[][] = [[]];
  let exhaustive = domains.every(domain => domain.exhaustive);
  for (const domain of domains) {
    const next: unknown[][] = [];
    outer: for (const prefix of values) for (const value of domain.values) {
      if (next.length >= limit) { exhaustive = false; break outer; }
      next.push([...prefix, value]);
    }
    values = next;
  }
  return { values, exhaustive };
}

export function integralBounds(schema: AnySchema, measure: Measure): { lower: number; upper: number | undefined } {
  let lower = counts(measure) ? 0 : -Infinity;
  let upper = Infinity;
  for (const rule of schema.invariants.flatMap(conjuncts)) {
    if (rule.kind !== "compare" || !isTerm(rule.left) || typeof rule.right !== "number") continue;
    const term = positionData(rule.left);
    if (term === undefined || term.path.length !== 0 || term.measure !== measure) continue;
    const value = rule.right;
    if (rule.operator === ">=") lower = Math.max(lower, Math.ceil(value));
    if (rule.operator === ">") lower = Math.max(lower, Math.floor(value) + 1);
    if (rule.operator === "<=") upper = Math.min(upper, Math.floor(value));
    if (rule.operator === "<") upper = Math.min(upper, Math.ceil(value) - 1);
    if (rule.operator === "==") { lower = Math.max(lower, Math.ceil(value)); upper = Math.min(upper, Math.floor(value)); }
  }
  return { lower, upper: Number.isFinite(upper) ? upper : undefined };
}
