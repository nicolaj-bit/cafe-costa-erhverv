# Café Costa Erhverv

Erhvervsportal til Café Costa Kalundborg som custom app i Shopify. Virksomheder
ansøger i butikken, ejeren godkender i Shopify admin, og godkendte kunder
bestiller til erhvervspris gennem den almindelige checkout.

Bygget som Lalatotos forudbestillings-app: **Base44 er serveren**, og appen
åbner indlejret i Shopify admin. Der er ingen Remix-server.

## Sådan hænger det sammen

| Del | Hvor | Hvad |
| --- | --- | --- |
| Ejerens side i admin | Base44 `/api/admin` og `/api/admin-indstillinger` | Polaris-side med ansøgninger, Godkend/Afvis og prisniveauer |
| Data til ejerens side | Base44 `/api/admin-data` | Kræver App Bridges ID token (signeret med appens client secret) |
| Ansøgningsformularen | Temablok «Erhvervsansøgning» → `/apps/erhverv` → Base44 `/api/erhverv-proxy` | App proxy. Shopify signerer kaldet; Base44 tjekker signaturen |
| Portalen | Temablok «Erhvervsportal» på `/pages/erhverv` | Ren Liquid ud fra kundens tags |
| Erhvervspriser | Rabatfunktionen `erhverv-rabat` | Procentrabat ud fra tagget `erhverv-niveau-1/2/3`. Kræver hverken Plus eller B2B |
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

1. `npx shopify app config link` → «Create new app» i samme organisation som
   `costa-kalundborg.myshopify.com`. Det skriver `client_id` i
   `shopify.app.toml`.
2. Base44 → appen → Dashboard → Secrets:
   - `SHOPIFY_STORE_DOMAIN` = `costa-kalundborg.myshopify.com` (sat)
   - `SHOPIFY_CLIENT_ID` = Client ID fra Dev Dashboard
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

`read_customers, write_customers, read_orders, read_products, write_discounts`.
Ingen scopes til abonnementer eller betalingsmetoder — de kræver Shopifys
godkendelse, og uden den fejler oprettelsen af app-versionen.

## Mails

Velkomst- og afvisningsmailen sendes med Base44's `SendEmail`. Til
modtagere, der ikke er brugere af Base44-appen, kræver Base44 et betalt
abonnement og eget domæne. Fejler mailen, bliver godkendelsen stående, og
ejeren får besked i admin.

## Ikke bygget endnu

- **Fast levering** vises som «Kommer snart». Bygges, når betalingsformen er
  besluttet og abonnementsmodulet valgt.

## Test

```bash
npm install
npm test
```

Rabatfunktionen kan køres lokalt på en eksempelkurv:

```bash
npx shopify app function run --path extensions/erhverv-rabat --export cart-lines-discounts-generate-run
```
