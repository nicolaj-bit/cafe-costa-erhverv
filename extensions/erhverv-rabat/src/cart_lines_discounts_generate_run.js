// Erhvervspriser: procentrabat på alle varer i kurven til en kunde med
// tagget erhverv-niveau-1, -2 eller -3. Gavekort får ikke rabat.
import { DiscountClass, ProductDiscountSelectionStrategy } from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

// Bruges kun, hvis ejeren endnu ikke har gemt satser på siden «Prisniveauer».
export const STANDARD_SATSER = { 1: 10, 2: 15, 3: 20 };

/** Satsen for kundens niveau. Har kunden flere niveau-tags, gælder det højeste. */
export function kundensSats(input) {
  const tags = input.cart.buyerIdentity?.customer?.hasTags ?? [];
  const config = input.discount.metafield?.jsonValue ?? {};
  const satser = { ...STANDARD_SATSER, ...(config.satser ?? {}) };
  let niveau = 0;
  for (const t of tags) {
    if (!t.hasTag) continue;
    const n = Number(t.tag.replace('erhverv-niveau-', ''));
    if (n > niveau) niveau = n;
  }
  if (!niveau) return null;
  const sats = Number(satser[niveau]);
  return Number.isFinite(sats) && sats > 0 ? { niveau, sats: Math.min(sats, 100) } : null;
}

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return { operations: [] };
  const fundet = kundensSats(input);
  if (!fundet) return { operations: [] };

  const targets = input.cart.lines
    .filter((l) => l.merchandise.__typename === 'ProductVariant' && !l.merchandise.product.isGiftCard)
    .map((l) => ({ cartLine: { id: l.id } }));
  if (!targets.length) return { operations: [] };

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: `Erhvervspris (${fundet.sats} %)`,
              targets,
              value: { percentage: { value: fundet.sats } },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
