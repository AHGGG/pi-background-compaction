// Extracted generic UI harness; original MIT copyright retained in LICENSE.
import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export function createCustomSelectorHarness(
  factory: unknown,
  width = 100,
  keybindingsOverride?: {
    matches(data: string, key: string): boolean;
    getKeys(key: string): readonly string[];
  },
  terminalRows = 24,
) {
  if (typeof factory !== "function") throw new Error("Expected a custom component factory");
  let result: unknown;
  let resolveResult!: (value: unknown) => void;
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const terminal = { rows: terminalRows };
  const component = (
    factory as (...args: unknown[]) => {
      render(width: number): string[];
      handleInput(data: string): void;
    }
  )(
    { terminal, requestRender() {} },
    {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    },
    keybindingsOverride ?? {
      matches(data: string, key: string) {
        const bindings: Record<string, KeyId> = {
          "tui.select.up": Key.up,
          "tui.select.down": Key.down,
          "tui.select.pageUp": Key.pageUp,
          "tui.select.pageDown": Key.pageDown,
          "tui.select.confirm": Key.enter,
          "tui.select.cancel": Key.escape,
          "tui.input.submit": Key.enter,
        };
        const binding = bindings[key];
        return (
          (binding !== undefined && matchesKey(data, binding)) ||
          (key === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
        );
      },
      getKeys(key: string): readonly string[] {
        if (key === "tui.select.up") return ["up"];
        if (key === "tui.select.down") return ["down"];
        if (key === "tui.select.confirm" || key === "tui.input.submit") return ["enter"];
        if (key === "tui.select.cancel") return ["escape", "ctrl+c"];
        return [];
      },
    },
    (value: unknown) => {
      result = value;
      resolveResult(value);
    },
  );
  return {
    handleInput(data: string) {
      const inputData: Record<string, string> = {
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.pageUp": "\u001b[5~",
        "tui.select.pageDown": "\u001b[6~",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
        "tui.input.submit": "\r",
      };
      component.handleInput(inputData[data] ?? data);
      return component.render(width);
    },
    render(renderWidth = width) {
      return component.render(renderWidth);
    },
    setTerminalRows(rows: number) {
      terminal.rows = rows;
    },
    invalidate() {
      (component as { invalidate?: () => void }).invalidate?.();
    },
    setFocused(focused: boolean) {
      if ("focused" in component) (component as { focused: boolean }).focused = focused;
    },
    async waitForPending() {
      await (component as { waitForPending?: () => Promise<void> }).waitForPending?.();
    },
    dispose() {
      (component as { dispose?: () => void }).dispose?.();
    },
    resultPromise,
    get isPiTuiKitScreen() {
      return (component as { __piTuiKitScreen?: true }).__piTuiKitScreen === true;
    },
    get isFocusable() {
      return "focused" in component;
    },
    get result() {
      return result;
    },
  };
}
