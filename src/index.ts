export type {} from "temporal-spec/global";

export {
  array,
  boolean,
  date,
  decimal,
  datetime,
  instant,
  int,
  enumOf as enum,
  literal,
  isVariantsSchema,
  number,
  object,
  record,
  string,
  time,
  variants,
  tagOf,
} from "./schema.js";
export type {
  AnySchema,
  AnyVariantsSchema,
  ArraySchema,
  Infer,
  InferShape,
  DateSchema,
  DateTimeSchema,
  EnumSchema,
  DecimalSchema,
  InstantSchema,
  IntSchema,
  ObjectSchema,
  OptionalSchema,
  RecordSchema,
  Schema,
  TimeSchema,
  VariantsSchema,
  VariantValue,
  Tags,
  ValidationIssue,
  ValidationResult,
  VariantOf,
} from "./schema.js";

export type { Comparable, Condition, InvariantRule, Operand, Operator, Rule, Term, TermOf } from "./rule.js";

export type { Beside } from "./beside.js";
export { formatTypeScriptValue } from "./codegen.js";

export { dependency, fake, FakeMiss } from "./dependency.js";
export type {
  AnyDependency,
  FakeTable,
  FunctionDependency,
  FunctionDependencyNames,
  Requirements,
  Resolved,
  Supplied,
  ValueDependencies,
  ValueDependency,
} from "./dependency.js";

export type { Border, BorderPoint, PointRole, PointStatus } from "./border.js";

export { positionsOf } from "./partition.js";
export type {
  DividedPosition,
  Position,
  UndividedPosition,
} from "./partition.js";

export {
  action,
  behavior,
  caseOf,
  external,
  implement,
  isBehavior,
  match,
  isCaseOnly,
  isTodo,
  todo,
  perform,
  SpecificationError,
  TodoDecision,
} from "./behavior.js";
export type {
  AnyBehavior,
  AnyImplementation,
  Behavior,
  BehaviorDeps,
  SuppliedDeps,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  CaseOnly,
  CasesWithDefault,
  ControlPolicy,
  ControlTable,
  Decision,
  Disregards,
  EnsuresBuilder,
  EnsuresClause,
  Execution,
  Guard,
  Implementation,
  ImplementationCases,
  Match,
  Otherwise,
  Todo,
  RulesDecision,
} from "./behavior.js";

export {
  spec,
  check,
  example,
  examples,
  evaluate,
  generate,
  isSpecification,
  test,
} from "./specification.js";
export type {
  AdequacyReport,
  CheckOptions,
  ArmCoverage,
  BehaviorWith,
  BorderCoverage,
  ComparisonsMeasure,
  ConformanceSubject,
  CoverageStatus,
  ControlGap,
  Coverage,
  Example,
  ExampleFailure,
  ExampleRow,
  ExampleSet,
  Expected,
  GeneratedExample,
  Incompleteness,
  GenerationOptions,
  GenerationReport,
  InputCaseEvidence,
  Measure,
  PairCount,
  PartitionCoverage,
  PendingDecision,
  ResultCaseEvidence,
  RuleCoverage,
  RulesMeasure,
  Specification,
  TestOutcome,
  RowEvaluation,
  UnansweredExample,
  Verdict,
} from "./specification.js";
export type { EnsuresClassification, EnsuresReading, EnsuresReport } from "./ensures.js";
export { FEASIBILITY_COMBINATION_LIMIT } from "./feasibility.js";
export { WAY_LIMIT } from "./ways.js";
export { reportDocument, reportSchemaVersion } from "./report-json.js";
export type { ReportSource, Weakening } from "./report-json.js";
export { compose, isComposition } from "./composition.js";

export { checkInvariants, invariants } from "./invariants.js";
export type { InvariantOperation, InvariantReport, Invariants, InvariantStep } from "./invariants.js";
export type { Composition } from "./composition.js";

export { decode, encode } from "./codec.js";
export type { JsonValue } from "./codec.js";

export { PAIR_LIMIT } from "./pairs.js";
export type { PairObligation, PairMeasure } from "./pairs.js";

export { model, bind, matchValue, map, fold, call, choose, construct, concat, arithmetic, quotient, plus, minus, between } from "./model.js";
export type { CalendarUnit, ClockUnit, Overflow } from "./temporal.js";
export type { Expression, Template } from "./model.js";

export { verify } from "./proof.js";
export type { ConstructionProof, ProofReport } from "./proof.js";

export { Rational, INT64_MIN, INT64_MAX } from "./exact.js";
export { int64, rational } from "./schema.js";
export type { Int64Schema, RationalSchema } from "./schema.js";

export { data } from "./data.js";
export type { DataSchema, Named } from "./data.js";
