import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

// A purchase order's payment terms: the two percents add up to 100.
const Terms = c
  .object({ prepayment: c.int().min(0).max(100), postpayment: c.int().min(0).max(100) })
  .refine("percents add up to 100", terms => terms.prepayment.$plus(terms.postpayment).$eq(100));

const amend = c.behavior("amend prepayment", {
  input: c.variants("kind", { amend: c.object({ po: Terms, prepayment: c.int().min(0).max(100) }) }),
  result: c.variants("outcome", { ok: c.object({ po: Terms }) }),
  effects: c.variants("type", {}),
});
const amendingOnlyPrepayment = c.implement(amend, {
  cases: {
    amend: c.model("changes the prepayment alone", request => ({
      result: { outcome: "ok" as const, po: { prepayment: request.prepayment, postpayment: request.po.postpayment } },
      effects: [],
    })),
  },
});
const amendingBoth = c.implement(amend, {
  cases: {
    amend: c.model("the postpayment takes the rest", request => ({
      result: {
        outcome: "ok" as const,
        po: { prepayment: request.prepayment, postpayment: c.arithmetic("subtract", 100, request.prepayment) },
      },
      effects: [],
    })),
  },
});

describe("invariants of a state several operations share", () => {
  it("finds the sequence that breaks one, with the state before and after each step", async () => {
    const report = await c.checkInvariants(
      c.invariants("payment terms", { state: Terms, operations: [{ implementation: amendingOnlyPrepayment, state: "po" }] }),
    );
    expect(report.status).toBe("broken");
    expect(report.counterexample!.reason).toMatch(/percents add up to 100/);
    const last = report.counterexample!.steps.at(-1)!;
    expect(last.operation).toBe("amend prepayment");
    expect((last.before as { prepayment: number; postpayment: number }).prepayment + (last.before as { postpayment: number }).postpayment).toBe(100);
  });

  it("holds when every operation keeps it, and says how often each one ran", async () => {
    const report = await c.checkInvariants(
      c.invariants("payment terms", { state: Terms, operations: [{ implementation: amendingBoth, state: "po" }] }),
      { runs: 50, steps: 5 },
    );
    expect(report).toMatchObject({ status: "held", runs: 50, steps: 250, operations: [{ name: "amend prepayment", ran: 250, moved: 250 }] });
    expect(report.counterexample).toBeUndefined();
  });

  it("draws the same sequences from the same seed", async () => {
    const declaration = c.invariants("payment terms", { state: Terms, operations: [{ implementation: amendingOnlyPrepayment, state: "po" }] });
    const first = await c.checkInvariants(declaration, { seed: 7 });
    const second = await c.checkInvariants(declaration, { seed: 7 });
    expect(second).toStrictEqual(first);
  });
});

// Lines of an order: no line receives more than it ordered.
const Line = c.object({ quantity: c.int().min(1).max(100), received: c.int().min(0) });
const Order = c
  .object({ lines: c.array(Line).min(1) })
  .refine("no line receives more than it ordered", order => order.lines.$all(line => line.received.$lte(line.quantity)));
const receive = c.behavior("receive", {
  input: c.variants("kind", { receive: c.object({ order: Order, quantity: c.int().min(1).max(100) }) }),
  result: c.variants("outcome", { ok: c.object({ order: Order }), tooMany: c.object({}) }),
  effects: c.variants("type", {}),
});
type Received = c.Execution<c.BehaviorResult<typeof receive>, c.BehaviorEffect<typeof receive>>;
// Checks what is still open across the whole order, then receives the
// quantity on every line: right for one line, wrong for several.
const receivingAgainstTheTotal = c.implement(receive, {
  cases: {
    receive: c.model("receives on every line what the whole order still has open", request => {
      const open = c.fold(Line, c.int(), request.order.lines, 0, (sum, line) =>
        c.arithmetic("add", sum, c.arithmetic("subtract", line.quantity, line.received)),
      );
      return c.bind(c.int(), open, remaining =>
        c.choose<Received>(
          request.quantity.$lte(remaining),
          {
            result: {
              outcome: "ok",
              order: {
                lines: c.map(Line, Line, request.order.lines, line => ({
                  quantity: line.quantity,
                  received: c.arithmetic("add", line.received, request.quantity),
                })),
              },
            },
            effects: [],
          },
          { result: { outcome: "tooMany" }, effects: [] },
        ),
      );
    }),
  },
});

describe("a state holding several items", () => {
  it("passes examples of one line, and breaks once the order has several", async () => {
    const one = (quantity: number, received: number, receiving: number) => ({ kind: "receive" as const, order: { lines: [{ quantity, received }] }, quantity: receiving });
    const examples = c.examples(receive, {
      "receives what is open": {
        given: one(10, 4, 6),
        expect: { result: { outcome: "ok", order: { lines: [{ quantity: 10, received: 10 }] } }, effects: [] },
      },
      "refuses more than is open": { given: one(10, 4, 7), expect: { result: { outcome: "tooMany" }, effects: [] } },
    });
    expect((await c.check(c.spec("receive", { examples, implementation: receivingAgainstTheTotal }))).failures).toStrictEqual([]);

    const report = await c.checkInvariants(
      c.invariants("order lines", { state: Order, operations: [{ implementation: receivingAgainstTheTotal, state: "order" }] }),
    );
    expect(report.status).toBe("broken");
    expect(report.counterexample!.reason).toMatch(/no line receives more than it ordered/);
    expect((report.counterexample!.steps.at(-1)!.before as { lines: unknown[] }).lines.length).toBeGreaterThan(1);
  });
});

describe("declaring invariants", () => {
  it("refuses an operation that takes no state", () => {
    expect(() =>
      c.invariants("payment terms", { state: Terms, operations: [{ implementation: amendingBoth, state: "order" }] }),
    ).toThrow("amend prepayment takes no order in any input case, so it cannot be handed the state");
  });

  it("draws records within their length bounds", async () => {
    const Tags = c.object({ tags: c.record(c.int().min(0).max(9)).min(3).max(5) });
    const replace = c.behavior("replace tags", {
      input: c.variants("kind", { replace: c.object({ state: Tags }) }),
      result: c.variants("outcome", { ok: c.object({ state: c.object({ tags: c.record(c.int()) }) }) }),
      effects: c.variants("type", {}),
    });
    const keeping = c.implement(replace, {
      cases: { replace: c.model("keeps the tags", request => ({ result: { outcome: "ok" as const, state: request.state }, effects: [] })) },
    });
    const kept = await c.checkInvariants(c.invariants("tags", { state: Tags, operations: [{ implementation: keeping, state: "state" }] }), { runs: 30, steps: 1 });
    expect(kept).toMatchObject({ status: "held", steps: 30 });

    // An operation that empties the tags shows the state it started from.
    const emptying = c.implement(replace, {
      cases: { replace: c.model("empties the tags", () => ({ result: { outcome: "ok" as const, state: { tags: {} } }, effects: [] })) },
    });
    const emptied = await c.checkInvariants(c.invariants("tags", { state: Tags, operations: [{ implementation: emptying, state: "state" }] }));
    const before = emptied.counterexample!.steps[0]!.before as { tags: Readonly<Record<string, number>> };
    expect(Object.keys(before.tags).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(before.tags).length).toBeLessThanOrEqual(5);
  });

  it("does not run when no state holds the invariants", async () => {
    const Impossible = c.object({ value: c.int().min(0).max(10) }).refine("above ten", state => state.value.$gt(10));
    const keep = c.behavior("keep", {
      input: c.variants("kind", { keep: c.object({ state: Impossible }) }),
      result: c.variants("outcome", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(keep, { cases: { keep: c.model("keeps", () => ({ result: { outcome: "ok" as const }, effects: [] })) } });
    const report = await c.checkInvariants(c.invariants("impossible", { state: Impossible, operations: [{ implementation, state: "state" }] }));
    expect(report.status).toBe("not run");
  });
});
