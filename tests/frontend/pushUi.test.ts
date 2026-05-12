import { describe, expect, test } from "bun:test";
import { matchHotkey } from "../../src/frontend/render.ts";

function ev(opts: { key: string; alt?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean }): { key: string; altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } {
  return {
    key: opts.key,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
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

describe("bare-n hotkey", () => {
  test("n with no modifiers → new-child", () => {
    expect(matchHotkey(ev({ key: "n" }))).toBe("new-child");
  });
  test("n with alt → null", () => {
    expect(matchHotkey(ev({ key: "n", alt: true }))).toBeNull();
  });
  test("n with shift → null", () => {
    expect(matchHotkey(ev({ key: "n", shift: true }))).toBeNull();
  });
  test("n with ctrl → null", () => {
    expect(matchHotkey(ev({ key: "n", ctrl: true }))).toBeNull();
  });
  test("n with meta → null", () => {
    expect(matchHotkey(ev({ key: "n", meta: true }))).toBeNull();
  });
});
