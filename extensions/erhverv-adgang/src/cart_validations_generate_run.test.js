import { describe, expect, it } from "vitest";
import { BESKED_GAEST, BESKED_IKKE_GODKENDT, cartValidationsGenerateRun } from "./cart_validations_generate_run";

const vare = (erhverv) => ({ merchandise: { __typename: "ProductVariant", product: { title: "Kaffe", hasAnyTag: erhverv } } });
const kurv = (kunde, ...linjer) => ({ cart: { buyerIdentity: kunde === undefined ? null : { customer: kunde }, lines: linjer } });
const fejl = (input) => cartValidationsGenerateRun(input).operations[0].validationAdd.errors;

describe("erhverv-adgang", () => {
  it("lader almindelige varer være", () => {
    expect(fejl(kurv(undefined, vare(false)))).toEqual([]);
  });
  it("lader en godkendt erhvervskunde købe erhvervsvarer", () => {
    expect(fejl(kurv({ hasAnyTag: true }, vare(true), vare(false)))).toEqual([]);
  });
  it("stopper en gæst med erhvervsvarer", () => {
    expect(fejl(kurv(undefined, vare(true)))).toEqual([{ message: BESKED_GAEST, target: "$.cart" }]);
  });
  it("stopper en kunde, der ikke er godkendt", () => {
    expect(fejl(kurv({ hasAnyTag: false }, vare(false), vare(true)))).toEqual([{ message: BESKED_IKKE_GODKENDT, target: "$.cart" }]);
  });
  it("tåler gavekort og andet uden produkt", () => {
    expect(fejl(kurv(undefined, { merchandise: { __typename: "CustomProduct" } }))).toEqual([]);
  });
});
