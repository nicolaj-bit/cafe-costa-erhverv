// @ts-check
// Erhvervsvarer må kun købes af godkendte erhvervskunder. Funktionen kører hos
// Shopify i kurv og checkout, så spærringen gælder også, hvis nogen finder
// produktet uden om portalen. Erhvervsvarer kendes på produktets tag «erhverv».

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

export const BESKED_GAEST = "Erhvervskaffen kan kun købes med en erhvervsaftale. Log ind som erhvervskunde, eller fjern varen fra kurven.";
export const BESKED_IKKE_GODKENDT = "Erhvervskaffen kan først købes, når jeres erhvervsaftale er godkendt. Fjern varen fra kurven, eller kontakt os.";

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const kunde = input.cart.buyerIdentity?.customer ?? null;
  const godkendt = Boolean(kunde?.hasAnyTag);
  const harErhvervsvarer = input.cart.lines.some(
    (l) => l.merchandise.__typename === "ProductVariant" && l.merchandise.product.hasAnyTag,
  );

  const errors = !harErhvervsvarer || godkendt
    ? []
    : [{ message: kunde ? BESKED_IKKE_GODKENDT : BESKED_GAEST, target: "$.cart" }];

  return { operations: [{ validationAdd: { errors } }] };
}
