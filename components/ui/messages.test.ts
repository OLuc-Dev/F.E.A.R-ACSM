import { describe, expect, it } from "vitest";

import { parseStrategicReply } from "@/components/ui/messages";

describe("parseStrategicReply", () => {
  it("returns null for a plain reply", () => {
    expect(parseStrategicReply("Claro, faço isso agora.")).toBeNull();
  });

  it("parses the full council structure", () => {
    const text = [
      "Leitura rápida:",
      "Você quer validar a ideia, não só admirá-la.",
      "",
      "Conselho interno:",
      "Contrarian: o risco é confundir estética com produto.",
      "First-Principles: quem usa, pra quê, e qual dor some?",
      "Expansionist: pode virar painel de comando pessoal.",
      "Outsider: o framing está insider demais.",
      "Executor: corte para um teste em 48h.",
      "",
      "Síntese do Chairman:",
      "Faça a menor versão que prova valor.",
      "",
      "Próximo passo:",
      "Escreva em uma frase quem é o usuário.",
    ].join("\n");

    const strat = parseStrategicReply(text);
    expect(strat).not.toBeNull();
    expect(strat?.quickRead).toContain("validar a ideia");
    expect(strat?.voices.map((voice) => voice.name)).toEqual([
      "Contrarian",
      "First-Principles",
      "Expansionist",
      "Outsider",
      "Executor",
    ]);
    expect(strat?.chairman).toContain("menor versão");
    expect(strat?.nextStep).toContain("uma frase");
  });

  it("needs at least two known headers to be treated as strategic", () => {
    const strat = parseStrategicReply(
      "Conselho interno:\nExecutor: teste rápido.\n\nSíntese do Chairman:\nVá.",
    );
    expect(strat).not.toBeNull();
    expect(strat?.voices).toHaveLength(1);
  });
});
