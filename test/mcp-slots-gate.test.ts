import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Regression tests for the MCP-side slots flag gate:
//   mcp::tools::call must not trigger mem::slot-* when AGENTMEMORY_SLOTS is
//   off — those functions are never registered (src/index.ts), and the
//   unhandled trigger error used to surface as an opaque 500. The MCP path
//   must return 503 + enableHow, matching the HTTP triggers (#678).

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeCall(name: string, args: Record<string, unknown> = {}) {
  return {
    body: { name, arguments: args },
    headers: {},
    query_params: {},
  };
}

type McpResponse = {
  status_code: number;
  body: { error?: string; flag?: string; enableHow?: string; content?: unknown };
};

describe("MCP memory_slot_* tools — flag gate", () => {
  let home: string;
  let ORIG_HOME: string | undefined;
  let ORIG_FLAG: string | undefined;

  beforeEach(() => {
    // Isolate HOME so a developer's real ~/.agentmemory/.env cannot
    // flip the flag underneath the test.
    home = mkdtempSync(join(tmpdir(), "am-mcp-slots-gate-"));
    mkdirSync(join(home, ".agentmemory"), { recursive: true });
    ORIG_HOME = process.env["HOME"];
    ORIG_FLAG = process.env["AGENTMEMORY_SLOTS"];
    process.env["HOME"] = home;
    delete process.env["AGENTMEMORY_SLOTS"];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env["HOME"] = ORIG_HOME;
    if (ORIG_FLAG !== undefined) process.env["AGENTMEMORY_SLOTS"] = ORIG_FLAG;
    else delete process.env["AGENTMEMORY_SLOTS"];
    rmSync(home, { recursive: true, force: true });
  });

  it("returns 503 with enableHow when slots are disabled (was opaque 500)", async () => {
    const { registerMcpEndpoints } = await import("../src/mcp/server.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never);

    const call = sdk.getFunction("mcp::tools::call")!;
    const res = (await call(makeCall("memory_slot_list"))) as McpResponse;

    expect(res.status_code).toBe(503);
    expect(res.body.flag).toBe("AGENTMEMORY_SLOTS");
    expect(res.body.enableHow).toContain("AGENTMEMORY_SLOTS=true");
  });

  it("gates every memory_slot_* tool, not just slot_list", async () => {
    const { registerMcpEndpoints } = await import("../src/mcp/server.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never);

    const call = sdk.getFunction("mcp::tools::call")!;
    const tools = [
      "memory_slot_get",
      "memory_slot_create",
      "memory_slot_append",
      "memory_slot_replace",
      "memory_slot_delete",
    ];
    for (const tool of tools) {
      const res = (await call(makeCall(tool, { label: "x" }))) as McpResponse;
      expect(res.status_code, tool).toBe(503);
    }
  });

  it("passes through to mem::slot-list when AGENTMEMORY_SLOTS=true", async () => {
    process.env["AGENTMEMORY_SLOTS"] = "true";
    const { registerMcpEndpoints } = await import("../src/mcp/server.js");
    const { registerSlotsFunctions } = await import("../src/functions/slots.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerSlotsFunctions(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);

    const call = sdk.getFunction("mcp::tools::call")!;
    const res = (await call(makeCall("memory_slot_list"))) as McpResponse;

    expect(res.status_code).toBe(200);
    expect(res.body.content).toBeDefined();
  });
});
