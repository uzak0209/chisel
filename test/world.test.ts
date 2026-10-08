import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

// Purchase orders, each DRAFT, APPROVED or ISSUED; an issued one receives.
const Planned = c.object({ id: c.string(), quantity: c.int().min(1).max(10) });
const Issued = c.object({ id: c.string(), quantity: c.int().min(1).max(10), received: c.int().min(0) });
const Order = c.variants("status", { DRAFT: Planned, APPROVED: Planned, ISSUED: Issued });
const Orders = c.object({ orders: c.array(Order) });
type OrdersState = c.Infer<typeof Orders>;
type OrderValue = c.Infer<typeof Order>;

const answers = c.variants("outcome", { ok: c.object({ order: Order }), refused: c.object({}) });
type Answer = c.Execution<c.Infer<typeof answers>, never>;
const refused: Answer = { result: { outcome: "refused" }, effects: [] };

const create = c.behavior("create", {
  input: c.variants("kind", { create: c.object({ id: c.string(), quantity: c.int().min(1).max(10) }) }),
  result: answers,
  effects: c.variants("type", {}),
});
const creating = c.implement(create, {
  cases: { create: c.model("a new order is a draft", r => ({ result: { outcome: "ok" as const, order: { status: "DRAFT" as const, id: r.id, quantity: r.quantity } }, effects: [] })) },
});

const approve = c.behavior("approve", { input: Order, result: answers, effects: c.variants("type", {}) });
const approving = c.implement(approve, {
  cases: {
    DRAFT: c.model("a draft is approved", r => ({ result: { outcome: "ok" as const, order: { status: "APPROVED" as const, id: r.id, quantity: r.quantity } }, effects: [] })),
    $default: c.model("only a draft is approved", () => refused),
  },
});

const issue = c.behavior("issue", { input: Order, result: answers, effects: c.variants("type", {}) });
const issuing = c.implement(issue, {
  cases: {
    APPROVED: c.model("an approved order is issued", r => ({ result: { outcome: "ok" as const, order: { status: "ISSUED" as const, id: r.id, quantity: r.quantity, received: 0 } }, effects: [] })),
    $default: c.model("only an approved order is issued", () => refused),
  },
});

// Receiving and changing the quantity both act on an order and a number.
const receive = c.behavior("receive", {
  input: c.variants("status", {
    DRAFT: c.object({ order: Planned, quantity: c.int().min(1).max(10) }),
    APPROVED: c.object({ order: Planned, quantity: c.int().min(1).max(10) }),
    ISSUED: c.object({ order: Issued, quantity: c.int().min(1).max(10) }),
  }),
  result: answers,
  effects: c.variants("type", {}),
});
const changeQuantity = c.behavior("change quantity", {
  input: c.variants("status", {
    DRAFT: c.object({ order: Planned, to: c.int().min(1).max(10) }),
    APPROVED: c.object({ order: Planned, to: c.int().min(1).max(10) }),
    ISSUED: c.object({ order: Issued, to: c.int().min(1).max(10) }),
  }),
  result: answers,
  effects: c.variants("type", {}),
});
const receiving = c.implement(receive, {
  cases: {
    ISSUED: c.model("receives no more than is open", r =>
      c.choose<Answer>(
        r.order.received.$plus(r.quantity).$lte(r.order.quantity),
        { result: { outcome: "ok", order: { status: "ISSUED", id: r.order.id, quantity: r.order.quantity, received: c.arithmetic("add", r.order.received, r.quantity) } }, effects: [] },
        refused,
      )),
    $default: c.model("only an issued order receives", () => refused),
  },
});
// Its guard looks at the new quantity alone, not at what is received.
const changingAnyQuantity = c.implement(changeQuantity, {
  cases: {
    ISSUED: c.model("takes any quantity", r => ({ result: { outcome: "ok" as const, order: { status: "ISSUED" as const, id: r.order.id, quantity: r.to, received: r.order.received } }, effects: [] })),
    $default: c.model("only an issued order changes", () => refused),
  },
});
const changingAboveReceived = c.implement(changeQuantity, {
  cases: {
    ISSUED: c.model("takes a quantity no less than received", r =>
      c.choose<Answer>(
        r.to.$gte(r.order.received),
        { result: { outcome: "ok", order: { status: "ISSUED", id: r.order.id, quantity: r.to, received: r.order.received } }, effects: [] },
        refused,
      )),
    $default: c.model("only an issued order changes", () => refused),
  },
});

// Each operation acts on one order: the world hands it an order and takes its answer back.
const replaced = (state: OrdersState, execution: { readonly result: unknown }): OrdersState => {
  const result = execution.result as c.Infer<typeof answers>;
  return result.outcome === "ok" ? { orders: state.orders.map(order => (order.id === result.order.id ? result.order : order)) } : state;
};
const onOrder = (implementation: c.AnyImplementation, field?: string): c.Operation<OrdersState> => ({
  implementation,
  input: (state, draw) => {
    const order = draw.pick(state.orders);
    if (order === undefined) return undefined;
    if (field === undefined) return order;
    const { status, ...rest } = order;
    return { status, order: rest, [field]: draw.int(1, 10) };
  },
  next: replaced,
});
const operations = (change: c.AnyImplementation): readonly c.Operation<OrdersState>[] => [
  {
    implementation: creating,
    input: (state, draw) => ({ kind: "create", id: `po-${state.orders.length + 1}`, quantity: draw.int(1, 10) }),
    next: (state, execution) => {
      const result = execution.result as c.Infer<typeof answers>;
      return result.outcome === "ok" ? { orders: [...state.orders, result.order] } : state;
    },
  },
  onOrder(approving),
  onOrder(issuing),
  onOrder(receiving, "quantity"),
  onOrder(change, "to"),
];

const neverOverReceived = c.invariant<OrdersState>("no order receives more than it ordered", state =>
  state.orders.$all(order => (order as unknown as c.TermOf<c.Infer<typeof Issued>>).received.$lte((order as unknown as c.TermOf<OrderValue & { quantity: number }>).quantity)),
);

describe("a world's invariants", () => {
  it("finds the operations whose guards together reach a state no single guard rules out", async () => {
    const report = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAnyQuantity), invariants: [neverOverReceived] }),
      { runs: 200, steps: 20 },
    );
    expect(report.status).toBe("broken");
    expect(report.counterexample!.invariant).toBe("no order receives more than it ordered");
    // Shortened to the steps that matter: one order, created, approved, issued, received, then cut below what it received.
    expect(report.counterexample!.steps.map(step => step.operation)).toStrictEqual(["create", "approve", "issue", "receive", "change quantity"]);
    const last = report.counterexample!.steps.at(-1)!.after as OrdersState;
    expect(last.orders).toHaveLength(1);
  });

  it("holds when the guards keep it, and says how often each operation ran and moved the state", async () => {
    const report = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), invariants: [neverOverReceived] }),
      { runs: 100, steps: 20 },
    );
    expect(report.status).toBe("held");
    for (const operation of report.operations) {
      expect(operation.ran).toBeGreaterThan(0);
      expect(operation.moved).toBeGreaterThan(0);
      expect(operation.pending).toBe(0);
    }
  });

  it("checks a transition between the state before an operation and after it", async () => {
    const shrinking = c.transition<OrdersState>("no order is lost", (before, after) => after.orders.$length().$gte(before.orders.$length()));
    const drop = c.behavior("drop", { input: Order, result: answers, effects: c.variants("type", {}) });
    const dropping = c.implement(drop, { cases: { $default: c.model("drops the order", r => ({ result: { outcome: "ok" as const, order: r as never }, effects: [] })) } } as never);
    const report = await c.explore(
      c.world("purchasing", {
        state: Orders,
        initial: [{ orders: [{ status: "DRAFT", id: "po-1", quantity: 1 }] }],
        operations: [{ implementation: dropping, input: (state, draw) => draw.pick(state.orders), next: (state, _execution, input) => ({ orders: state.orders.filter(order => order !== input) }) }],
        transitions: [shrinking],
      }),
    );
    expect(report).toMatchObject({ status: "broken", counterexample: { invariant: "no order is lost" } });
  });

  it("pairs each record before and after by what names it, as TLA+ quantifies over orders[id] and orders'[id]", async () => {
    const issuedStaysIssued = c.transition<OrderValue>("an issued order stays issued", { each: "orders", by: "id" }, (before, after) =>
      before.status.$ne("ISSUED").$or(after.status.$eq("ISSUED")),
    );
    const reopen = c.behavior("reopen", { input: Order, result: answers, effects: c.variants("type", {}) });
    // Sends an issued order back to a draft.
    const reopening = c.implement(reopen, {
      cases: {
        ISSUED: c.model("reopens", r => ({ result: { outcome: "ok" as const, order: { status: "DRAFT" as const, id: r.id, quantity: r.quantity } }, effects: [] })),
        $default: c.model("only an issued order reopens", () => refused),
      },
    });
    const broken = await c.explore(
      c.world("purchasing", {
        state: Orders,
        initial: [{ orders: [] }],
        operations: [...operations(changingAboveReceived), onOrder(reopening)],
        transitions: [issuedStaysIssued],
      }),
      { runs: 200, steps: 20 },
    );
    expect(broken.status).toBe("broken");
    expect(broken.counterexample!.invariant).toBe("an issued order stays issued");
    expect(broken.counterexample!.reason).toMatch(/^reopen moved orders po-\d+ in a way an issued order stays issued does not allow$/);
    expect(broken.counterexample!.steps.map(step => step.operation)).toStrictEqual(["create", "approve", "issue", "reopen"]);

    const held = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), transitions: [issuedStaysIssued] }),
      { runs: 50, steps: 20 },
    );
    expect(held.status).toBe("held");
  });

  it("does not hold a step that leaves the state as it was to a transition, as [][P]_vars does not", async () => {
    // Every step that moves the state adds an order; issuing a draft is refused and moves nothing.
    const growing = c.transition<OrdersState>("a step that moves the state adds an order", (before, after) =>
      after.orders.$length().$gt(before.orders.$length()),
    );
    const report = await c.explore(
      c.world("purchasing", {
        state: Orders,
        initial: [{ orders: [] }],
        operations: [operations(changingAboveReceived)[0]!, onOrder(issuing)],
        transitions: [growing],
      }),
      { runs: 20, steps: 10 },
    );
    expect(report.status).toBe("held");
    expect(report.operations[1]).toMatchObject({ name: "issue", moved: 0 });
    expect(report.operations[1]!.ran).toBeGreaterThan(0);
  });

  it("refuses to pair an array's elements without a field to match them by", async () => {
    const unmatched = c.transition<OrderValue>("an issued order stays issued", { each: "orders" }, (before, after) => before.status.$ne("ISSUED").$or(after.status.$eq("ISSUED")));
    await expect(
      c.explore(c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), transitions: [unmatched] })),
    ).rejects.toThrow("Transition an issued order stays issued pairs the elements of orders but names no field to match them by");
  });

  it("takes an invariant written as a model expression", async () => {
    const counted = c.invariant<OrdersState>("at most five orders", state =>
      c.bind(c.int(), c.fold(Order, c.int(), state.orders, 0, count => c.arithmetic("add", count, 1)), count => c.choose(count.$lte(5), true, false)),
    );
    const report = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), invariants: [counted] }),
      { runs: 20, steps: 20 },
    );
    expect(report).toMatchObject({ status: "broken", counterexample: { invariant: "at most five orders" } });
    expect(report.counterexample!.steps.filter(step => step.operation === "create")).toHaveLength(6);
  });

  it("hands an operation over the whole world the state at a field", async () => {
    const Count = c.object({ count: c.int().min(0) });
    const count = c.behavior("count", {
      input: c.variants("kind", { add: c.object({ state: Count, by: c.int().min(0).max(3) }) }),
      result: c.variants("outcome", { ok: c.object({ state: Count }) }),
      effects: c.variants("type", {}),
    });
    const adding = c.implement(count, {
      cases: { add: c.model("adds", r => ({ result: { outcome: "ok" as const, state: { count: c.arithmetic("add", r.state.count, r.by) } }, effects: [] })) },
    });
    const report = await c.explore(
      c.world("counter", {
        state: Count,
        initial: [{ count: 0 }],
        operations: [{ implementation: adding, state: "state" }],
        invariants: [c.invariant<c.Infer<typeof Count>>("below twenty", state => state.count.$lt(20))],
      }),
      { runs: 5, steps: 30 },
    );
    expect(report).toMatchObject({ status: "broken", counterexample: { invariant: "below twenty" } });
  });

  it("checks an explicit null at the state's field as the next state, rather than as the state left as it was", async () => {
    const Count = c.object({ count: c.int().min(0) });
    const clear = c.behavior("clear", {
      input: c.variants("kind", { clear: c.object({ state: Count }) }),
      result: c.variants("outcome", { cleared: c.object({ state: c.literal(null) }) }),
      effects: c.variants("type", {}),
    });
    const clearing = c.implement(clear, { cases: { clear: c.model("clears", () => ({ result: { outcome: "cleared" as const, state: null }, effects: [] })) } });
    const report = await c.explore(
      c.world("counter", {
        state: Count,
        initial: [{ count: 0 }],
        operations: [{ implementation: clearing, state: "state" }],
        invariants: [c.invariant<c.Infer<typeof Count>>("not negative", state => state.count.$gte(0))],
      }),
      { runs: 1, steps: 1 },
    );
    expect(report).toMatchObject({ status: "broken", counterexample: { reason: "clear left a value that is not a state: $: Expected an object" } });
    expect(report.counterexample!.steps).toMatchObject([{ before: { count: 0 }, after: null }]);
  });

  it("draws the same walks from the same seed", async () => {
    const declaration = c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAnyQuantity), invariants: [neverOverReceived] });
    expect(await c.explore(declaration, { seed: 3 })).toStrictEqual(await c.explore(declaration, { seed: 3 }));
  });

  it("draws an integer between bounds that are not integers, and refuses bounds with none between them", async () => {
    const Count = c.object({ count: c.int().min(0) });
    const tick = c.behavior("tick", {
      input: c.variants("kind", { tick: c.object({}) }),
      result: c.variants("outcome", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const ticking = c.implement(tick, { cases: { tick: c.model("ticks", () => ({ result: { outcome: "ok" as const }, effects: [] })) } });
    const drawn = new Set<number>();
    const declaration = (min: number, max: number) => c.world("counter", {
      state: Count,
      initial: [{ count: 0 }],
      operations: [{ implementation: ticking, input: (_, draw) => { drawn.add(draw.int(min, max)); return { kind: "tick" }; }, next: state => state }],
      invariants: [c.invariant<c.Infer<typeof Count>>("not negative", state => state.count.$gte(0))],
    });
    await c.explore(declaration(0.5, 2.5), { runs: 1, steps: 50 });
    expect([...drawn].sort()).toStrictEqual([1, 2]);
    await expect(c.explore(declaration(3, 1), { runs: 1, steps: 1 })).rejects.toThrow("draw.int has no integer from 3 to 1");
    await expect(c.explore(declaration(1.2, 1.8), { runs: 1, steps: 1 })).rejects.toThrow("draw.int has no integer from 1.2 to 1.8");
  });

  it("does not count a next state that differs only by an optional field written as undefined as moved", async () => {
    const Noted = c.object({ count: c.int().min(0), note: c.string().optional() });
    const tick = c.behavior("tick", {
      input: c.variants("kind", { tick: c.object({}) }),
      result: c.variants("outcome", { ok: c.object({ note: c.string().optional() }) }),
      effects: c.variants("type", {}),
    });
    const ticking = c.implement(tick, { cases: { tick: c.model("ticks", () => ({ result: { outcome: "ok" as const }, effects: [] })) } });
    const report = await c.explore(
      c.world("counter", {
        state: Noted,
        initial: [{ count: 0 }],
        operations: [{
          implementation: ticking,
          input: () => ({ kind: "tick" }),
          // As a JavaScript `next` might, writing the note it did not get as undefined.
          next: (state, execution) => ({ ...state, note: (execution.result as { note?: string }).note }) as c.Infer<typeof Noted>,
        }],
        invariants: [c.invariant<c.Infer<typeof Noted>>("not negative", state => state.count.$gte(0))],
      }),
      { runs: 1, steps: 3 },
    );
    expect(report.operations).toStrictEqual([{ name: "tick", ran: 3, moved: 0, skipped: 0, pending: 0 }]);
  });

  it("reports a starting state that breaks an invariant", async () => {
    const report = await c.explore(
      c.world("purchasing", {
        state: Orders,
        initial: [{ orders: [{ status: "ISSUED", id: "po-1", quantity: 1, received: 2 }] }],
        operations: operations(changingAboveReceived),
        invariants: [neverOverReceived],
      }),
    );
    expect(report).toMatchObject({ status: "broken", counterexample: { invariant: "no order receives more than it ordered", steps: [] } });
  });

  describe("an operation whose next changes the state it is handed", () => {
    const Count = c.object({ count: c.int().min(0) });
    type CountState = c.Infer<typeof Count>;
    const tick = c.behavior("tick", {
      input: c.variants("kind", { tick: c.object({}) }),
      result: c.variants("outcome", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const ticking = c.implement(tick, { cases: { tick: c.model("ticks", () => ({ result: { outcome: "ok" as const }, effects: [] })) } });
    const incrementing: c.Operation<CountState> = {
      implementation: ticking,
      input: () => ({ kind: "tick" }),
      next: state => { (state as { count: number }).count++; return state; },
    };

    it("keeps the state before the step, so a transition sees what it was", async () => {
      const report = await c.explore(
        c.world("counter", {
          state: Count,
          initial: [{ count: 0 }],
          operations: [incrementing],
          transitions: [c.transition<CountState>("never grows", (before, after) => after.count.$lte(before.count))],
        }),
        { runs: 1, steps: 1 },
      );
      expect(report).toMatchObject({ status: "broken", counterexample: { invariant: "never grows", start: { count: 0 } } });
      expect(report.counterexample!.steps).toMatchObject([{ before: { count: 0 }, after: { count: 1 } }]);
    });

    it("starts every walk and every replay from the starting state as declared", async () => {
      const declaration = c.world("counter", {
        state: Count,
        initial: [{ count: 0 }],
        operations: [incrementing],
        invariants: [c.invariant<CountState>("below three", state => state.count.$lt(3))],
      });
      const report = await c.explore(declaration, { runs: 3, steps: 3 });
      expect(declaration.initial).toStrictEqual([{ count: 0 }]);
      // Shortening replays from the start, so it keeps the three steps that reach three.
      expect(report).toMatchObject({ status: "broken", runs: 1, operations: [{ ran: 3, moved: 3 }], counterexample: { invariant: "below three", start: { count: 0 } } });
      expect(report.counterexample!.steps.map(step => step.before)).toStrictEqual([{ count: 0 }, { count: 1 }, { count: 2 }]);
    });
  });
});

describe("what a walk leaves unchecked", () => {
  it("is undetermined when an operation never ran, since the walks said nothing about it", async () => {
    // Nothing creates an order, so approving never has one to act on.
    const report = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: [onOrder(approving)], invariants: [neverOverReceived] }),
      { runs: 5, steps: 5 },
    );
    expect(report).toMatchObject({ status: "undetermined", operations: [{ name: "approve", ran: 0, skipped: 25 }] });
    expect(report.reason).toBe("approve never ran: it had nothing to act on in any state reached");
  });

  it("tells an operation no step chose from one that had nothing to act on", async () => {
    const report = await c.explore(
      c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), invariants: [neverOverReceived] }),
      { runs: 1, steps: 1 },
    );
    expect(report.status).toBe("undetermined");
    const unchosen = report.operations.filter(operation => operation.ran === 0 && operation.skipped === 0);
    expect(unchosen.length).toBeGreaterThan(0);
    for (const operation of unchosen) expect(report.reason).toContain(`${operation.name} never ran: no step chose it in 1 step`);
    expect(report.reason).not.toMatch(/nothing to act on/);
  });

  it("counts a case still todo as pending, not as a broken invariant", async () => {
    const pendingApproval = c.implement(approve, { cases: { DRAFT: c.todo("approval rules"), $default: c.model("only a draft is approved", () => refused) } });
    const report = await c.explore(
      c.world("purchasing", {
        state: Orders,
        initial: [{ orders: [{ status: "DRAFT", id: "po-1", quantity: 1 }] }],
        operations: [onOrder(pendingApproval)],
        invariants: [neverOverReceived],
      }),
      { runs: 3, steps: 3 },
    );
    expect(report.status).toBe("undetermined");
    expect(report.operations[0]).toMatchObject({ ran: 0, pending: 9 });
    expect(report.reason).toMatch(/^approve could not be run: /);
  });

  it("refuses runs or steps that are not a positive integer", async () => {
    const declaration = c.world("purchasing", { state: Orders, initial: [{ orders: [] }], operations: operations(changingAboveReceived), invariants: [neverOverReceived] });
    await expect(c.explore(declaration, { runs: 0 })).rejects.toThrow("runs must be a positive integer, but was 0");
    await expect(c.explore(declaration, { steps: Number.NaN })).rejects.toThrow("steps must be a positive integer, but was NaN");
  });
});

describe("declaring a world", () => {
  const base = { state: Orders, initial: [{ orders: [] }] as OrdersState[], operations: operations(changingAboveReceived), invariants: [neverOverReceived] };
  it("refuses a world with no starting state, no operation or no invariant", () => {
    expect(() => c.world("w", { ...base, initial: [] })).toThrow("World w starts from no state");
    expect(() => c.world("w", { ...base, operations: [] })).toThrow("World w names no operation");
    expect(() => c.world("w", { ...base, invariants: [] })).toThrow("World w states no invariant");
  });
  it("refuses an invariant named twice, a starting state that is not a state, and an operation that takes no state", () => {
    expect(() => c.world("w", { ...base, invariants: [neverOverReceived, neverOverReceived] })).toThrow("World w names invariant no order receives more than it ordered more than once");
    expect(() => c.world("w", { ...base, initial: [{ orders: [{ status: "DRAFT", id: "po-1", quantity: 0 }] }] })).toThrow(/World w starting state 1 is not a state/);
    expect(() => c.world("w", { ...base, operations: [{ implementation: approving, state: "orders" }] })).toThrow("approve takes no orders in any input case, so it cannot be handed the state");
  });
});
