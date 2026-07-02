// Small, pure helpers to represent the signed-in account in the UI. No hooks,
// no DOM — so they are unit-testable in the Node test runner.

/** The short name F.E.A.R. uses for the account: the email's local part. */
export function accountName(email: string): string {
  const local = (email.split("@")[0] || "").trim();
  return local || "você";
}

/** A single uppercase initial for the account avatar. */
export function accountInitial(email: string): string {
  return (email.trim()[0] || "?").toUpperCase();
}

/** Label for the "Sua chave" system row (never an error tone). */
export function keyStatusLabel(hasKey: boolean): string {
  return hasKey ? "ativa" : "faltando";
}
