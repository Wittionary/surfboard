import { describe, expect, test } from "bun:test";
import { matchHotkey } from "../../src/frontend/render.ts";

function ev(opts: { key: string; alt?: boolean; shift?: boolean }): { key: string; altKey: boolean; shiftKey: boolean } {
  return {
    key: opts.key,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
  };
}

describe("spec §8.7 hotkeys", () => {
  test("Alt+Shift+U → push-all", () => {
    expect(matchHotkey(ev({ key: "U", alt: true, shift: true }))).toBe("push-all");
  });
  test("Alt+Shift+I → pull-all", () => {
    expect(matchHotkey(ev({ key: "I", alt: true, shift: true }))).toBe("pull-all");
  });
  test("Alt+Shift+J → push-selected", () => {
    expect(matchHotkey(ev({ key: "J", alt: true, shift: true }))).toBe("push-selected");
  });
  test("Alt+Shift+K → pull-selected", () => {
    expect(matchHotkey(ev({ key: "K", alt: true, shift: true }))).toBe("pull-selected");
  });
  test("Alt+Shift+V → refresh", () => {
    expect(matchHotkey(ev({ key: "V", alt: true, shift: true }))).toBe("refresh");
  });
  test("lowercase variants normalized", () => {
    expect(matchHotkey(ev({ key: "u", alt: true, shift: true }))).toBe("push-all");
  });
  test("missing modifier disables match", () => {
    expect(matchHotkey(ev({ key: "U", shift: true }))).toBeNull();
    expect(matchHotkey(ev({ key: "U", alt: true }))).toBeNull();
  });
  test("unrelated keys return null", () => {
    expect(matchHotkey(ev({ key: "Z", alt: true, shift: true }))).toBeNull();
    expect(matchHotkey(ev({ key: "Enter", alt: true, shift: true }))).toBeNull();
  });
});
