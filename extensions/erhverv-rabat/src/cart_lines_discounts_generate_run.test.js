import { describe, expect, it } from 'vitest';
import { cartLinesDiscountsGenerateRun } from './cart_lines_discounts_generate_run';

const linje = (id, isGiftCard = false) => ({ id, merchandise: { __typename: 'ProductVariant', product: { isGiftCard } } });
const input = ({ tags = [], satser, lines = [linje('gid://shopify/CartLine/1')], classes = ['PRODUCT'] } = {}) => ({
  cart: {
    buyerIdentity: tags === null ? null : { customer: { hasTags: ['erhverv-niveau-1', 'erhverv-niveau-2', 'erhverv-niveau-3'].map((t) => ({ tag: t, hasTag: tags.includes(t) })) } },
    lines,
  },
  discount: { discountClasses: classes, metafield: satser ? { jsonValue: { satser } } : null },
});

describe('erhvervspriser', () => {
  it('giver ingen rabat til en almindelig kunde', () => {
    expect(cartLinesDiscountsGenerateRun(input())).toEqual({ operations: [] });
  });

  it('giver ingen rabat, når ingen er logget ind', () => {
    expect(cartLinesDiscountsGenerateRun(input({ tags: null }))).toEqual({ operations: [] });
  });

  it('bruger satsen for kundens niveau fra indstillingerne', () => {
    const res = cartLinesDiscountsGenerateRun(input({ tags: ['erhverv-niveau-2'], satser: { 1: 5, 2: 12, 3: 25 } }));
    expect(res.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(12);
  });

  it('bruger standardsatsen, før ejeren har gemt satser', () => {
    const res = cartLinesDiscountsGenerateRun(input({ tags: ['erhverv-niveau-3'] }));
    expect(res.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(20);
  });

  it('vælger det højeste niveau, hvis kunden har flere', () => {
    const res = cartLinesDiscountsGenerateRun(input({ tags: ['erhverv-niveau-1', 'erhverv-niveau-3'], satser: { 1: 5, 2: 10, 3: 15 } }));
    expect(res.operations[0].productDiscountsAdd.candidates[0].value.percentage.value).toBe(15);
  });

  it('giver ikke rabat på gavekort', () => {
    const res = cartLinesDiscountsGenerateRun(input({ tags: ['erhverv-niveau-1'], lines: [linje('a'), linje('b', true)] }));
    expect(res.operations[0].productDiscountsAdd.candidates[0].targets).toEqual([{ cartLine: { id: 'a' } }]);
  });

  it('gør intet, når satsen er 0', () => {
    expect(cartLinesDiscountsGenerateRun(input({ tags: ['erhverv-niveau-1'], satser: { 1: 0 } }))).toEqual({ operations: [] });
  });
});
