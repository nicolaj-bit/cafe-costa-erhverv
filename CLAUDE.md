# Café Costa Erhverv

Læs `README.md` først.

- **Skriv altid på dansk**: svar, commit-beskeder og kodekommentarer.
- Nicolaj er ikke udvikler. Hold svarene korte, og forklar hvorfor frem for
  hvordan. Afslut med en linje, der starter med `NÆSTE:`.
- Arbejd på en gren og lav en draft-PR. Push aldrig direkte til `main`.
- **Tjek butikken før hver skrivning til Shopify** (`get-shop-info`). Den
  skal være Costa (`costa-kalundborg-2amkkegx.myshopify.com`). Forbindelsen har før skiftet
  til Lalatotos live-butik uden varsel.
- Ingen nøgler i repoet. Client secret står kun i Base44's secrets.
- Serverkoden ligger i Base44 (app `6af2086e391faa45cbbca2d0`). `base44-app/`
  er en spejling — ret i Base44 og kopiér hertil, ellers driver de fra
  hinanden.
- Entiteten `Virksomhed` må kun læses og skrives med `asServiceRole` efter
  kontrol af kalderen: ID token fra admin eller app proxy-signaturen.
- Ingen scopes til abonnementer eller betalingsmetoder.
- Nyhedsbrevsfeltet må aldrig være krydset af på forhånd.
- Temablokkene bruger temaets costa-klasser og variabler fra
  `costa-tokens.css` (temaet `nicolaj-bit/cafe-costa-theme`). Ingen egne farver
  eller skrifter.
