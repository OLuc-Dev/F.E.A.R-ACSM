import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantMessage, ReplyBody } from "@/components/ui/messages";

// Render the markdown reply to an HTML string (no DOM/jsdom needed) and assert
// on the output — covers the scope plus the security guarantees.
const html = (md: string) => renderToStaticMarkup(<ReplyBody text={md} />);

describe("ReplyBody markdown", () => {
  it("renders an unordered list", () => {
    const out = html("- um\n- dois");
    expect(out).toContain("<ul");
    expect(out).toContain("<li>um</li>");
    expect(out).toContain("<li>dois</li>");
  });

  it("renders an ordered list", () => {
    const out = html("1. primeiro\n2. segundo");
    expect(out).toContain("<ol");
    expect(out).toContain("primeiro");
    expect(out).toContain("segundo");
  });

  it("keeps **bold**", () => {
    expect(html("isso é **forte**")).toContain("<strong>forte</strong>");
  });

  it("renders inline code", () => {
    expect(html("use `npm ci` aqui")).toContain("<code>npm ci</code>");
  });

  it("renders a fenced code block inside <pre><code>", () => {
    const out = html("```\nconst x = 1;\n```");
    expect(out).toContain("<pre>");
    expect(out).toContain("const x = 1;");
  });

  it("makes links open safely in a new tab", () => {
    const out = html("veja [aqui](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("never executes raw HTML — it is escaped as text", () => {
    const out = html('texto <img src=x onerror="alert(1)"> fim');
    // The tag is escaped to characters (&lt;img…), not emitted as a real
    // element — so no <img> renders and its onerror can never fire. ("onerror="
    // still appears, but only as inert text inside the escaped string.)
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
  });

  it("neutralizes a javascript: link", () => {
    const out = html("[x](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
  });
});

// The consulted-memories chip: an honest transparency cue under the reply.
describe("AssistantMessage consulted chip", () => {
  const render = (content: string, consultedCount?: number) =>
    renderToStaticMarkup(<AssistantMessage content={content} consultedCount={consultedCount} />);

  it("renders no chip when nothing was consulted", () => {
    expect(render("resposta simples")).not.toContain("consultada");
    expect(render("resposta simples", 0)).not.toContain("consultada");
  });

  it("renders the singular label for one memory", () => {
    expect(render("resposta", 1)).toContain("1 memória consultada nesta resposta");
  });

  it("renders the plural label for several memories", () => {
    expect(render("resposta", 3)).toContain("3 memórias consultadas nesta resposta");
  });

  it('says "consultada", never "usada" — no false causality', () => {
    const out = render("resposta", 2);
    expect(out).toContain("consultadas nesta resposta");
    expect(out).not.toMatch(/usadas?\s/);
  });

  it("never shows the chip over the typing dots (empty content)", () => {
    expect(render("", 2)).not.toContain("consultada");
  });

  it("never renders raw memory ids (they are not even given to the component)", () => {
    // The chip receives only a count — by design ids cannot leak into the thread.
    expect(render("resposta", 2)).not.toContain("consultedMemoryIds");
  });
});
