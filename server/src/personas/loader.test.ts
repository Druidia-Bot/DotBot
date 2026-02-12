/**
 * Persona Loader Tests
 * 
 * Covers:
 * - parseFrontMatter: CRLF/LF handling, YAML parsing, arrays, edge cases
 * - Persona loading: getReceptionist, getPersona, getIntakeAgents, etc.
 * - registerUserPersona: runtime persona registration
 */

import { describe, it, expect } from "vitest";
import {
  parseFrontMatter,
  getReceptionist,
  getUpdater,
  getPersona,
  getIntakeAgents,
  getInternalPersonas,
  registerUserPersona,
} from "./loader.js";

// ============================================
// FRONTMATTER PARSING
// ============================================

describe("parseFrontMatter", () => {
  it("parses standard LF frontmatter", () => {
    const content = "---\nid: test\nname: Test\n---\n\nBody content here.";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.id).toBe("test");
    expect(result!.frontMatter.name).toBe("Test");
    expect(result!.body).toBe("Body content here.");
  });

  it("parses CRLF frontmatter (Windows line endings)", () => {
    const content = "---\r\nid: receptionist\r\nname: Receptionist\r\ntype: intake\r\nmodelTier: fast\r\ndescription: Routes requests\r\n---\r\n\r\n# Body\r\n\r\nSome content.";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.id).toBe("receptionist");
    expect(result!.frontMatter.name).toBe("Receptionist");
    expect(result!.frontMatter.type).toBe("intake");
    expect(result!.frontMatter.modelTier).toBe("fast");
    expect(result!.frontMatter.description).toBe("Routes requests");
    expect(result!.body).toContain("# Body");
  });

  it("parses mixed line endings (CRLF + LF)", () => {
    const content = "---\r\nid: mixed\nname: Mixed\r\n---\n\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.id).toBe("mixed");
    expect(result!.frontMatter.name).toBe("Mixed");
  });

  it("parses array values in brackets", () => {
    const content = "---\nid: dev\nname: Dev\ntools: [filesystem, shell, http]\n---\n\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.tools).toEqual(["filesystem", "shell", "http"]);
  });

  it("parses CRLF with array values", () => {
    const content = "---\r\nid: dev\r\nname: Dev\r\ntools: [filesystem, shell]\r\n---\r\n\r\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.tools).toEqual(["filesystem", "shell"]);
  });

  it("parses modelRole from frontmatter", () => {
    const content = "---\nid: architect-bot\nname: Architect\nmodelRole: architect\n---\n\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.modelRole).toBe("architect");
  });

  it("parses all valid modelRole values", () => {
    for (const role of ["workhorse", "deep_context", "architect", "local"]) {
      const content = `---\nid: test\nname: Test\nmodelRole: ${role}\n---\n\nBody`;
      const result = parseFrontMatter(content);
      expect(result!.frontMatter.modelRole).toBe(role);
    }
  });

  it("leaves modelRole undefined when not present", () => {
    const content = "---\nid: test\nname: Test\n---\n\nBody";
    const result = parseFrontMatter(content);
    expect(result!.frontMatter.modelRole).toBeUndefined();
  });

  it("returns null for content without frontmatter", () => {
    expect(parseFrontMatter("No frontmatter here")).toBeNull();
    expect(parseFrontMatter("---\nno closing delimiter")).toBeNull();
    expect(parseFrontMatter("")).toBeNull();
  });

  it("returns null for incomplete frontmatter", () => {
    // Only opening ---
    expect(parseFrontMatter("---\nid: test\n")).toBeNull();
    // Only closing ---
    expect(parseFrontMatter("some content\n---\n")).toBeNull();
  });

  it("handles empty body after frontmatter", () => {
    const content = "---\nid: empty\nname: Empty\n---\n";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.id).toBe("empty");
    expect(result!.body).toBe("");
  });

  it("handles colons in description values", () => {
    const content = "---\nid: test\ndescription: This has: a colon in it\n---\n\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.description).toBe("This has: a colon in it");
  });

  it("trims whitespace from keys and values", () => {
    const content = "---\n  id  :  spaced  \n  name  :  Spaced Name  \n---\n\nBody";
    const result = parseFrontMatter(content);

    expect(result).not.toBeNull();
    expect(result!.frontMatter.id).toBe("spaced");
    expect(result!.frontMatter.name).toBe("Spaced Name");
  });
});

// ============================================
// PERSONA LOADING (integration — reads from disk)
// ============================================

describe("Persona Loading", () => {
  it("loads receptionist persona", () => {
    const receptionist = getReceptionist();
    expect(receptionist).toBeDefined();
    expect(receptionist!.id).toBe("receptionist");
    expect(receptionist!.type).toBe("intake");
    expect(receptionist!.systemPrompt).toBeTruthy();
  });

  it("loads updater persona", () => {
    const updater = getUpdater();
    expect(updater).toBeDefined();
    expect(updater!.id).toBe("updater");
    expect(updater!.type).toBe("intake");
  });

  it("returns undefined for non-existent persona", () => {
    expect(getPersona("definitely_not_real")).toBeUndefined();
  });

  it("loads intake agents", () => {
    const agents = getIntakeAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const agent of agents) {
      expect(agent.type).toBe("intake");
      expect(agent.id).toBeTruthy();
      expect(agent.systemPrompt).toBeTruthy();
    }
  });

  it("loads internal personas", () => {
    const personas = getInternalPersonas();
    expect(personas.length).toBeGreaterThanOrEqual(1);
    for (const persona of personas) {
      expect(persona.type).toBe("internal");
      expect(persona.id).toBeTruthy();
      expect(persona.systemPrompt).toBeTruthy();
    }
  });

  it("all personas have required fields", () => {
    const allPersonas = [...getIntakeAgents(), ...getInternalPersonas()];
    for (const p of allPersonas) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.type).toMatch(/^(intake|internal)$/);
      expect(p.modelTier).toMatch(/^(fast|smart|powerful)$/);
      expect(p.systemPrompt).toBeTruthy();
    }
  });
});

// ============================================
// USER PERSONA REGISTRATION
// ============================================

describe("registerUserPersona", () => {
  it("registers and retrieves a user-defined persona", () => {
    registerUserPersona({
      id: "custom_test_bot",
      name: "Test Bot",
      type: "internal",
      modelTier: "fast",
      description: "A test persona",
      systemPrompt: "You are a test bot.",
      tools: [],
    });

    const persona = getPersona("custom_test_bot");
    expect(persona).toBeDefined();
    expect(persona!.name).toBe("Test Bot");
    expect(persona!.systemPrompt).toBe("You are a test bot.");
  });
});
