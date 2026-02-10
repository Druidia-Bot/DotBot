/**
 * Agent Runner — Module Export Tests
 * 
 * Validates that the refactored runner + extracted intake/execution modules
 * export all expected symbols and the AgentRunner class is constructable.
 */

import { describe, it, expect } from "vitest";

describe("Runner Module Exports", () => {
  it("exports AgentRunner class", async () => {
    const mod = await import("./runner.js");
    expect(mod.AgentRunner).toBeDefined();
    expect(typeof mod.AgentRunner).toBe("function");
  });

  it("exports AgentRunnerOptions type (runtime check via class constructor)", async () => {
    const { AgentRunner } = await import("./runner.js");
    // The class exists and can be referenced — the type system enforces options shape at compile time
    expect(AgentRunner.prototype).toBeDefined();
  });
});

describe("Intake Module Exports", () => {
  it("exports all intake persona runners", async () => {
    const mod = await import("./intake.js");
    
    expect(typeof mod.runReceptionist).toBe("function");
    expect(typeof mod.runPlanner).toBe("function");
    expect(typeof mod.runChairman).toBe("function");
    expect(typeof mod.runJudge).toBe("function");
    expect(typeof mod.runUpdaterAsync).toBe("function");
  });
});

describe("Execution Module Exports", () => {
  it("exports all execution functions", async () => {
    const mod = await import("./execution.js");
    
    expect(typeof mod.executePlan).toBe("function");
    expect(typeof mod.executeWithPersona).toBe("function");
    expect(typeof mod.executeWithPersonaPlain).toBe("function");
    expect(typeof mod.generateSimpleResponse).toBe("function");
  });
});

describe("Tool Loop Exports", () => {
  it("exports runToolLoop", async () => {
    const mod = await import("./tool-loop.js");
    expect(typeof mod.runToolLoop).toBe("function");
  });
});

describe("Condenser Exports", () => {
  it("exports condenser and loop resolver", async () => {
    const mod = await import("./condenser.js");
    expect(typeof mod.runCondenser).toBe("function");
    expect(typeof mod.runLoopResolver).toBe("function");
  });
});

describe("Task Monitor Exports", () => {
  it("exports all public functions", async () => {
    const mod = await import("./task-monitor.js");
    expect(typeof mod.getTimeEstimate).toBe("function");
    expect(typeof mod.startTaskTimer).toBe("function");
    expect(typeof mod.clearTaskTimer).toBe("function");
    expect(typeof mod.getActiveTaskCount).toBe("function");
  });
});

describe("Persona Loader — Judge", () => {
  it("loads the Judge intake persona", async () => {
    const { getJudge, initServerPersonas } = await import("../personas/loader.js");
    initServerPersonas();
    const judge = getJudge();
    expect(judge).toBeDefined();
    expect(judge!.id).toBe("judge");
    expect(judge!.type).toBe("intake");
    expect(judge!.modelTier).toBe("fast");
  });
});

describe("Self-Recovery Exports", () => {
  it("exports RunJournal class", async () => {
    const mod = await import("./self-recovery.js");
    expect(mod.RunJournal).toBeDefined();
    expect(typeof mod.RunJournal).toBe("function");
  });

  it("exports diagnostic functions", async () => {
    const mod = await import("./self-recovery.js");
    expect(typeof mod.diagnoseError).toBe("function");
    expect(typeof mod.buildFailureReport).toBe("function");
    expect(typeof mod.buildRecoveryContext).toBe("function");
  });
});
