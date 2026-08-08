import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSlackResultPresenter } from "../lib/slack-presenter";

describe("Slack command result presenter", () => {
  it("shows TUI results ephemerally and only puts them in the editor on explicit input", async () => {
    const setEditorText = vi.fn();
    const notify = vi.fn();
    const events: string[] = [];
    const waitForIdle = vi.fn(async () => {
      events.push("idle");
    });
    const custom = vi.fn(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: string) => void,
        ) =>
          | { handleInput?: (input: string) => void }
          | Promise<{ handleInput?: (input: string) => void }>,
      ) => {
        events.push("custom");
        return new Promise<string>((resolve) => {
          void Promise.resolve(
            factory(
              { requestRender: vi.fn() } as never,
              {
                fg: (_name: string, text: string) => text,
                bold: (text: string) => text,
              } as never,
              {} as never,
              resolve,
            ),
          ).then((component) => component.handleInput?.("e"));
        });
      },
    );
    const context = {
      mode: "tui",
      waitForIdle,
      ui: {
        custom,
        setEditorText,
        notify,
      },
    } as unknown as ExtensionCommandContext;
    const presenter = createSlackResultPresenter();

    await presenter.present(context, {
      title: "Slack search: deploy",
      text: "**Alice**: deploy complete",
      details: { operation: "search", total: 1 },
    });

    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(events.slice(0, 2)).toEqual(["idle", "custom"]);
    expect(custom).toHaveBeenCalledWith(expect.any(Function));
    expect(setEditorText).toHaveBeenCalledWith(
      expect.stringContaining("untrusted external content"),
    );
    expect(setEditorText).toHaveBeenCalledWith(
      expect.stringContaining("**Alice**: deploy complete"),
    );
    expect(notify).toHaveBeenCalledWith(
      "Slack result loaded into the input editor. Review it, then press Enter to send it to the agent.",
      "info",
    );
  });
});
