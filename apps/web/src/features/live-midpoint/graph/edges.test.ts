import { describe, it, expect } from "vitest";
import { EDGES, TOPO_ORDER, assertAcyclic } from "./edges";
import type { EdgeMap, NodeId } from "./edges";

describe("assertAcyclic", () => {
  it("accepts the live-midpoint graph", () => {
    expect(() => assertAcyclic(EDGES)).not.toThrow();
  });

  it("orders every node after all of its dependencies", () => {
    const position = new Map(TOPO_ORDER.map((id, i) => [id, i]));
    for (const id of Object.keys(EDGES) as NodeId[]) {
      for (const dep of EDGES[id]) {
        expect(position.get(dep)).toBeLessThan(position.get(id) ?? -1);
      }
    }
  });

  it("includes every declared node exactly once", () => {
    const ids = Object.keys(EDGES);
    expect(TOPO_ORDER).toHaveLength(ids.length);
    expect(new Set(TOPO_ORDER).size).toBe(ids.length);
  });

  it("resolves a diamond dependency", () => {
    const diamond = {
      slots: [],
      midpoint: ["slots"],
      venues: ["midpoint"],
      destination: ["midpoint", "venues"],
      routes: ["destination"],
      frame: ["routes"],
    } as unknown as EdgeMap;

    const order = assertAcyclic(diamond);
    expect(order.indexOf("destination")).toBeGreaterThan(
      order.indexOf("venues"),
    );
    expect(order.indexOf("destination")).toBeGreaterThan(
      order.indexOf("midpoint"),
    );
  });

  // The cycle that appears the moment anyone re-centres venue search on the
  // selected venue, or derives a time-balanced midpoint from route durations.
  it("rejects a cycle and names the nodes involved", () => {
    const cyclic = {
      slots: [],
      midpoint: ["slots", "destination"],
      venues: ["midpoint"],
      destination: ["midpoint", "venues"],
      routes: [],
      frame: [],
    } as unknown as EdgeMap;

    expect(() => assertAcyclic(cyclic)).toThrow(/cycle/i);
    expect(() => assertAcyclic(cyclic)).toThrow(/destination/);
    expect(() => assertAcyclic(cyclic)).toThrow(/midpoint/);
  });

  it("rejects a dependency on an undeclared node", () => {
    const dangling = {
      slots: [],
      midpoint: ["nonexistent"],
      venues: [],
      destination: [],
      routes: [],
      frame: [],
    } as unknown as EdgeMap;

    expect(() => assertAcyclic(dangling)).toThrow(/Unknown dependency/);
    expect(() => assertAcyclic(dangling)).toThrow(/nonexistent/);
  });

  it("rejects a self-edge", () => {
    const selfLoop = {
      slots: ["slots"],
      midpoint: [],
      venues: [],
      destination: [],
      routes: [],
      frame: [],
    } as unknown as EdgeMap;

    expect(() => assertAcyclic(selfLoop)).toThrow(/cycle/i);
  });
});
