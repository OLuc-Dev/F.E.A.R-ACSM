// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AuthPanel } from "@/components/ui/auth-panel";
import type { AuthUser } from "@/lib/api";

afterEach(cleanup);

const noop = () => {};
const asyncNoop = vi.fn(async () => {});

const baseProps = {
  open: true,
  onClose: noop,
  onSignIn: asyncNoop,
  onSignUp: asyncNoop,
  onSignOut: noop,
  onSaveKey: asyncNoop,
};

const userNoKey: AuthUser = {
  id: "u-1",
  email: "joao@example.com",
  has_openrouter_key: false,
  chat_model: "",
  persona_mode: "",
};

describe("AuthPanel", () => {
  it("shows the sign-in form when logged out", () => {
    const { container } = render(<AuthPanel {...baseProps} user={null} />);
    expect(screen.getByPlaceholderText("e-mail")).toBeTruthy();
    expect(screen.getByPlaceholderText("senha")).toBeTruthy();
    expect(container.querySelector('button[type="submit"]')?.textContent).toContain("Entrar");
  });

  it("submits credentials to onSignIn", async () => {
    const onSignIn = vi.fn(async () => {});
    const { container } = render(<AuthPanel {...baseProps} onSignIn={onSignIn} user={null} />);
    fireEvent.change(screen.getByPlaceholderText("e-mail"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("senha"), { target: { value: "segredo123" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(onSignIn).toHaveBeenCalledWith("a@b.com", "segredo123");
  });

  it("shows the OpenRouter key field for a signed-in user without a key", () => {
    render(<AuthPanel {...baseProps} user={userNoKey} />);
    expect(screen.getByText("joao@example.com")).toBeTruthy();
    // The key input is a password field (never echoes the secret back).
    const keyInput = screen.getByPlaceholderText("sk-or-v1-…") as HTMLInputElement;
    expect(keyInput).toBeTruthy();
    expect(keyInput.type).toBe("password");
    expect(screen.getByRole("button", { name: /salvar chave/i })).toBeTruthy();
  });

  it("surfaces a human error when sign-in fails", async () => {
    const onSignIn = vi.fn(async () => {
      throw new Error("Credenciais inválidas.");
    });
    const { container } = render(<AuthPanel {...baseProps} onSignIn={onSignIn} user={null} />);
    fireEvent.change(screen.getByPlaceholderText("e-mail"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByPlaceholderText("senha"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(screen.getByText("Credenciais inválidas.")).toBeTruthy();
  });
});
