# Café Costa Erhverv

Erhvervsportal til Café Costa Kalundborg som custom app i Shopify. Virksomheder
ansøger i butikken, ejeren godkender i Shopify admin, og godkendte kunder
bestiller til erhvervspris gennem den almindelige checkout.

Bygget som Lalatotos forudbestillings-app: **Base44 er serveren**, og appen
åbner indlejret i Shopify admin. Der er ingen Remix-server.

## Sådan hænger det sammen

| Del | Hvor | Hvad |
| --- | --- | --- |
| Ejerens side i admin | Base44 `/api/admin` (fanerne Ansøgninger, Aftaler, Indstillinger) | Café Costas look: temaets `--costa`-variabler og skrifter (`/api/admin-skrift`). App Bridge giver menu, titellinje, beskeder og bekræftelser |
| Aftaler | Fanen Aftaler | Faste leveringer regnet ud fra ordrer med tagget `Subscription` — appen har ingen adgang til abonnementerne. Fejlet trækning = næste ordre er mere end et døgn forsinket |
| Min aftale | Portalen → `GET /apps/erhverv` → Base44 `/api/erhverv-proxy` | Kundens egne faste leveringer, med app proxy-signaturen og `logged_in_customer_id` |
| Data til ejerens side | Base44 `/api/admin-data` | Kræver App Bridges ID token (signeret med appens client secret) |
| Ansøgningsformularen | Temablok «Erhvervsansøgning» → `/apps/erhverv` → Base44 `/api/erhverv-proxy` | App proxy. Shopify signerer kaldet; Base44 tjekker signaturen |
| Portalen | Temablok «Erhvervsportal» på `/pages/erhverv` | Ren Liquid ud fra kundens tags |
| Erhvervspriser | Rabatfunktionen `erhverv-rabat` | Procentrabat ud fra tagget `erhverv-niveau-1/2/3`. Kræver hverken Plus eller B2B |
| Kun for erhvervskunder | Valideringsfunktionen `erhverv-adgang` | Stopper kurv og checkout, hvis der er en vare med produkt-tagget `erhverv`, og kunden ikke har `erhverv-godkendt`. Slås til under Indstillinger → Kasse → Kasseregler |
| Virksomheder | Base44-entiteten `Virksomhed` | Kun serveren læser og skriver, efter kontrol af kalderen |

Base44-appen hedder «Café Costa Erhverv» (id `6af2086e391faa45cbbca2d0`,
`https://cafe-costa-erhverv-cbbca2d0.base44.app`). Koden ligger i Base44;
`base44-app/` er en spejling til review. Ret i Base44 og kopiér hertil.

### Tags på kunden

| Tag | Betyder |
| --- | --- |
| `erhverv` | Har ansøgt (bliver stående) |
| `erhverv-afventer` | Venter på ejeren |
| `erhverv-godkendt` + `erhverv-niveau-X` | Godkendt på prisniveau X |
| `erhverv-afvist` | Afvist |

Firmanavn, CVR, kontaktperson og prisniveau gemmes også som metafelter på
kunden (`erhverv.*`), så portalen kan vise dem.

### Prisniveauer

Satserne gemmes to steder i Shopify, når ejeren trykker Gem:

- på den automatiske rabat «Erhvervspriser» (`$app:erhverv.config`), som
  rabatfunktionen læser
- på butikken (`erhverv.niveauer`), som portalen bruger til at vise prisen

Rabatten oprettes første gang, ejeren gemmer. Indtil da giver portalen
standardsatserne 10, 15 og 20 %, men checkout giver ingen rabat.

## Installér på udviklingsbutikken

1. Appen er oprettet i organisationen LALATOTO of Denmark ApS
   (Client ID `a7053cb43a97c70401eb8cbc11774f9f`). Pas på: `shopify app config
   link` overskriver `shopify.app.toml` med Shopifys standard og fjerner app
   proxy og kommentarer — gendan filen fra git bagefter.
2. Base44 → appen → Dashboard → Secrets:
   - `SHOPIFY_STORE_DOMAIN` = `costa-kalundborg-2amkkegx.myshopify.com` (sat). Brug butikkens interne myshopify-domæne, ikke `costa-kalundborg.myshopify.com`, som kun er en henvisning — ellers afvises tokenet med «Tokenet er til en anden butik»
   - `SHOPIFY_CLIENT_ID` = Client ID (sat)
   - `SHOPIFY_CLIENT_SECRET` = Client secret fra Dev Dashboard
3. `npx shopify app deploy` — sender scopes, app proxy, temablokke og
   rabatfunktionen.
4. Dev Dashboard → appen → Installér på `costa-kalundborg`.
5. Åbn appen i admin → Prisniveauer → Gem. Det opretter rabatten.
6. Temaet: læg «Erhvervsansøgning» på siden Kaffe til erhverv og
   «Erhvervsportal» på `/pages/erhverv`, og vælg erhvervskollektionen.

Appen henter selv sit token til Admin API'et med *client credentials*. Det
virker kun, fordi app og butik ligger i samme organisation. Senere på den
rigtige butik vælges *Custom distribution* i Dev Dashboard.

### Scopes

`read_customers, write_customers, read_orders, read_products, write_discounts`
og `write_app_proxy`. Det sidste kræver Shopify, fordi formularen går gennem
app proxy — uden det afvises app-versionen. Ingen scopes til abonnementer eller betalingsmetoder — de kræver Shopifys
godkendelse, og uden den fejler oprettelsen af app-versionen.

### Byg i et miljø uden adgang til cdn.jsdelivr.net

Shopify CLI henter `wasm-opt` derfra, når rabatfunktionen bygges. Er adressen
spærret, så hent den fra npm i stedet:

```bash
npm pack binaryen@123.0.0 && tar xzf binaryen-123.0.0.tgz
cp package/bin/wasm-opt node_modules/@shopify/cli/bin/wasm-opt.cjs
```

## Mails

Velkomst- og afvisningsmailen sendes med Base44's `SendEmail`. Til
modtagere, der ikke er brugere af Base44-appen, kræver Base44 et betalt
abonnement og eget domæne. Fejler mailen, bliver godkendelsen stående, og
ejeren får besked i admin.

## Fast levering

Shopify Subscriptions står for abonnementerne, kortet og trækningerne. Appen
har bevidst ingen scopes til abonnementer: «Aftaler» og «Min aftale» regnes ud
fra ordrerne med tagget `Subscription`. Teksten til abonnementspolitikken står
i `docs/abonnementsbetingelser.md`.

## Shopify Plus på den rigtige butik

Shopify tillader kun funktioner (rabatten `erhverv-rabat` og spærringen
`erhverv-adgang`) i en **custom app** på Plus-butikker. Udviklingsbutikker er
undtaget. På Café Costas rigtige butik uden Plus skal appen derfor enten
distribueres som offentlig (unlisted) app, eller butikken skal på Plus.

## Test

```bash
npm install
npm test
```

Rabatfunktionen kan køres lokalt på en eksempelkurv:

```bash
npx shopify app function run --path extensions/erhverv-rabat --export cart-lines-discounts-generate-run
```
