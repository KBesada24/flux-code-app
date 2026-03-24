import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import ProjectScriptsControl from "./ProjectScriptsControl";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function TestHarness({
  initialScripts,
  preferredScriptId = null,
  onDeleteScript,
}: {
  initialScripts: ProjectScript[];
  preferredScriptId?: string | null;
  onDeleteScript?: (scriptId: string) => Promise<void>;
}) {
  const [scripts, setScripts] = useState(initialScripts);

  return (
    <ProjectScriptsControl
      scripts={scripts}
      keybindings={EMPTY_KEYBINDINGS}
      preferredScriptId={preferredScriptId}
      onRunScript={() => {}}
      onAddScript={() => {}}
      onUpdateScript={() => {}}
      onDeleteScript={async (scriptId) => {
        await onDeleteScript?.(scriptId);
        setScripts((current) => current.filter((script) => script.id !== scriptId));
      }}
    />
  );
}

async function waitForElement<T extends Element>(
  getter: () => T | null,
  message: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = getter();
      expect(element, message).toBeTruthy();
    },
    { timeout: 8_000, interval: 16 },
  );
  return element!;
}

async function waitForButtonByAriaLabel(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label.replaceAll('"', '\\"')}"]`,
      ),
    `Unable to find button with aria-label "${label}".`,
  );
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button): button is HTMLButtonElement => button.textContent?.trim() === text,
      ) ?? null,
    `Unable to find button with text "${text}".`,
  );
}

async function openEditDialog(scriptName: string): Promise<void> {
  const menuButton = await waitForButtonByAriaLabel("Script actions");
  menuButton.click();

  await waitForElement(
    () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
        item.textContent?.includes(scriptName),
      ) ?? null,
    `Unable to find menu item for "${scriptName}".`,
  );

  const editButton = await waitForButtonByAriaLabel(`Edit ${scriptName}`);
  editButton.click();

  await waitForElement(
    () =>
      Array.from(document.querySelectorAll('[data-slot="dialog-title"]')).find(
        (title) => title.textContent?.trim() === "Edit Action",
      ) ?? null,
    "Unable to find edit dialog title.",
  );
}

async function confirmDeleteAction(): Promise<void> {
  const alertDialog = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-slot="alert-dialog-popup"]'),
    "Unable to find delete confirmation dialog.",
  );
  const confirmButton = Array.from(alertDialog.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement => button.textContent?.trim() === "Delete action",
  );
  expect(confirmButton, "Unable to find delete confirmation button.").toBeTruthy();
  confirmButton!.click();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProjectScriptsControl deletion", () => {
  it("removes a deleted script from the top-bar menu", async () => {
    const screen = await render(
      <TestHarness
        initialScripts={[
          {
            id: "build",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
          {
            id: "test",
            name: "Test",
            command: "bun run test",
            icon: "test",
            runOnWorktreeCreate: false,
          },
        ]}
      />,
    );

    try {
      await openEditDialog("Build");
      (await waitForButtonByText("Delete action")).click();
      await confirmDeleteAction();

      await vi.waitFor(
        () => {
          const titles = Array.from(document.querySelectorAll("button[title]")).map((button) =>
            button.getAttribute("title"),
          );
          expect(titles).not.toContain("Run Build");
        },
        { timeout: 8_000, interval: 16 },
      );

      const menuButton = await waitForButtonByAriaLabel("Script actions");
      menuButton.click();

      await vi.waitFor(
        () => {
          const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) =>
            item.textContent?.trim(),
          );
          expect(menuItems).toContain("Test");
          expect(menuItems).not.toContain("Build");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("restores the add button when deleting the only script", async () => {
    const screen = await render(
      <TestHarness
        initialScripts={[
          {
            id: "build",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ]}
      />,
    );

    try {
      await openEditDialog("Build");
      (await waitForButtonByText("Delete action")).click();
      await confirmDeleteAction();

      await vi.waitFor(
        () => {
          const addActionButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.includes("Add action") || button.title === "Add action",
          );
          expect(addActionButton).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the edit dialog open when delete confirmation is canceled", async () => {
    const screen = await render(
      <TestHarness
        initialScripts={[
          {
            id: "build",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ]}
      />,
    );

    try {
      await openEditDialog("Build");
      (await waitForButtonByText("Delete action")).click();
      const cancelButtons = Array.from(document.querySelectorAll("button")).filter(
        (button): button is HTMLButtonElement => button.textContent?.trim() === "Cancel",
      );
      cancelButtons.at(-1)?.click();

      await vi.waitFor(
        () => {
          const title = Array.from(document.querySelectorAll('[data-slot="dialog-title"]')).find(
            (item) => item.textContent?.trim() === "Edit Action",
          );
          const nameInput = document.querySelector<HTMLInputElement>("#script-name");
          expect(title).toBeTruthy();
          expect(nameInput?.value).toBe("Build");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to the next script when deleting the preferred action", async () => {
    const screen = await render(
      <TestHarness
        initialScripts={[
          {
            id: "lint",
            name: "Lint",
            command: "bun run lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
          {
            id: "test",
            name: "Test",
            command: "bun run test",
            icon: "test",
            runOnWorktreeCreate: false,
          },
        ]}
        preferredScriptId="test"
      />,
    );

    try {
      expect((await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Run Test"]'),
        "Unable to find preferred script button.",
      )).title).toBe("Run Test");

      await openEditDialog("Test");
      (await waitForButtonByText("Delete action")).click();
      await confirmDeleteAction();

      await vi.waitFor(
        () => {
          const nextPrimary = document.querySelector<HTMLButtonElement>('button[title="Run Lint"]');
          expect(nextPrimary).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("does not show delete in add mode", async () => {
    const screen = await render(<TestHarness initialScripts={[]} />);

    try {
      (await waitForButtonByText("Add action")).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="dialog-title"]')).find(
            (title) => title.textContent?.trim() === "Add Action",
          ) ?? null,
        "Unable to find add action dialog.",
      );

      const deleteButtons = Array.from(document.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Delete action",
      );
      expect(deleteButtons).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
