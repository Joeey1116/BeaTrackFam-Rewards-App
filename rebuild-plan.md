# Rewards app rebuild plan — off Shopify onto Cloudflare (survey Nov 4, 2026)

Joey approved Nov 4, 2026: rebuild the Rewards (loyalty) app the same way the
main app was rebuilt today — off Shopify, onto the Cloudflare storefront.
Nothing is pushed to GitHub, submitted to Apple, or uploaded to any store
without his explicit go-ahead. Local commits only until he says so.

## Survey headline — the rebuild is server-side, not app-side

The Rewards app contains **zero Shopify code**. Grep over `app/`, `components/`,
`lib/`, `widgets/` finds no Shopify URL, SDK, GraphQL, Storefront token,
`products.json`/`collections.json` fetch, cart, or checkout. The app talks only
to Supabase (Auth, profiles, points_ledger, rewards, redemptions) and opens
external links (`beatrackfam.info`, Instagram, TikTok). There is:

- NO in-app product catalog to re-point to `/api/catalog` (the main-app
  catalog work does not apply here — the only shop surfaces are buttons
  opening `https://beatrackfam.info` in an in-app browser).
- NO in-app checkout to move to PaymentSheet (the app sells nothing in-app;
  purchasing happens entirely on the website).
- NO accounts migration: sign-in is Supabase Auth and **stays** Supabase Auth.
  The Cloudflare D1 `customer_accounts` system is a separate store-account
  identity; a Rewards user must NOT be pushed through `/api/account/*`
  (that would create a second identity).

What actually depends on Shopify lives in `supabase/functions/`:

1. **Order points** — `shopify-order` (Shopify `orders/paid` webhook, HMAC,
   flat 25 pts/order, `action_id = shopify-order-<id>`). Dies with Shopify.
2. **Redemption codes** — `redeem-reward`'s live route creates single-use
   codes via the Shopify Admin API (price rule + discount code, usage
   limit 1). Dies with Shopify. The `code_pool` rows are pre-created
   Shopify codes and become worthless at lapse too.

Nothing in-app is broken today by the Oct 30 domain flip (the app never
fetched `products.json`), and nothing in-app breaks Nov 16 either — but
without this rebuild, **order points stop** and **redemption codes stop
being valid store codes** on cutover.

## What stays untouched

Supabase Auth (PKCE, `lib/supabase.ts`, `lib/auth.tsx`); `profiles` /
`points_ledger` / `rewards` / `redemptions` schema; tier thresholds
(Fam 0 / Loyal 500 / Ride or Die 1500, computed from points, plus the
`sync_tier()` DB trigger); reward costs (100 / 250 / 500 / 1000 / birthday 0);
referral 50/50; idempotent redemption flow (`redeem-reward` +
`complete_redemption()`); Resend code emails; push-token storage.
No SQL migration is needed: `complete_redemption()` already accepts any
`delivery` string and only draws from `code_pool` when `delivery = 'pool'`,
so a new `'cloudflare'` delivery value works with zero schema change.

## Build part 1 — order points (code exists; deploy + secrets are the work)

`supabase/functions/cloudflare-order/index.ts` is already written and mirrors
`shopify-order` exactly: POST `{order_number, email, amount_cents}` with
`Authorization: Bearer <REWARDS_TRIGGER_SECRET>`, flat 25 pts/order
(`amount_cents` validated but does not change the grant), idempotent via
`points_ledger.action_id = cloudflare-order-<order_number>` (pre-check plus
unique-violation → `already_credited`), exact-email profile match, no
profile ever created, fail-closed when the secret is unset (500) or the
bearer is wrong (401). The Cloudflare caller
(`backend/src/index.js` `fireRewardsTrigger`, reached via the `prod-deploy`
wrapper which imports `backend/src`) already sends exactly this payload
with a 5s timeout and never fails the order on trigger failure.

Remaining (parent-side, needs Joey/dashboard — no secret values in chat
or files, ever):

1. Commit `cloudflare-order/` (currently untracked) and deploy ONLY it to
   Supabase (do not touch `shopify-order` until cutover).
2. Set `REWARDS_TRIGGER_SECRET` (one value) as a Supabase function secret
   AND as a Cloudflare Worker secret (`wrangler secret put`), and set
   Worker secret `REWARDS_WEBHOOK_URL` to
   `https://<project>.supabase.co/functions/v1/cloudflare-order`.
   Then redeploy the Worker so the trigger activates (code today skips
   silently when either secret is missing).
3. Verify live: POST the endpoint with a non-member email + the secret →
   expect `{ok:true, credited:false, reason:'no_profile'}` (proves auth +
   validation without awarding points). A member-email test awards a real
   25 pts — reverse afterwards via the `award_points` RPC with a negative
   delta if it was only a test.
4. Replay safety (no-retry gap, by design): a failed trigger is only
   logged on the Worker side. Recovery is a manual re-POST of the same
   payload with the secret — idempotency makes it safe (`already_credited`
   on duplicates). No retry queue is built.

Also fixed in this rebuild (backend, local code — see deploy note below):
**test orders must not award points.** Today the test-confirm path
(`POST /api/checkout/confirm-test`) calls `fireOrderPaid`, which fires the
trigger — a simulated payment would grant a real 25 pts, and the payload
carries no test flag for the receiver to filter on. Fix: `fireOrderPaid`
takes a `{skipRewards}` option; the test-confirm path passes it. The
Stripe webhook mark-paid path is unchanged (trigger still fires). This is
the safer shape versus adding a test flag: no deploy-ordering hazard
between backend and receiver.

## Build part 2 — redemption codes (the actual code work)

Replace the Shopify live route in `redeem-reward` with a Cloudflare mint
route. New Worker endpoint (local code in `prod-deploy/src/storefront-api.js`,
next to `/api/discounts/validate`):

- `POST /api/rewards/mint-code`, auth `Authorization: Bearer` against the
  Worker secret `REWARDS_TRIGGER_SECRET` (same shared secret value as the
  points trigger — one secret to manage, fail-closed 500 when unset,
  401 on mismatch). Body: `{code, discount_kind, discount_value,
  min_subtotal}`. Creates a D1 `catalog_discounts` row + `catalog_discount_meta`
  via `catalogStore.upsertDiscount` (same store the checkout reads).
- Mapping from the Supabase `rewards` row (unchanged `discount_kind` /
  `discount_value` / `min_subtotal` columns):

  | Reward | Supabase mapping | D1 discount written |
  |---|---|---|
  | 10% Off (100 pts) | `percent`, 10 | `value_type=percentage, value_num=10`, `max_uses_total=1` |
  | Free Shipping (250 pts) | `shipping`, 100 | `value_type=free_shipping, value_num=0`, `max_uses_total=1` |
  | $10 Off (500 pts) | `amount`, 10, `min_subtotal` 25 | `value_type=fixed, value_num=1000`, `min_type=amount, min_value=2500`, `max_uses_total=1` |
  | Free Tee (1000 pts) | `free_product`, null | NO code minted — stays manual-claim (email to confirm size), exactly as today |
  | Birthday 10% Off (0 pts) | `percent`, 10 | Same as 10% Off |

  Single-use enforcement moves to the store: `max_uses_total=1` is enforced
  by `evaluateDiscount` against applied-order usage counts, so the code
  works once at Cloudflare checkout and then rejects. Eligibility stays
  open (all customers), matching Shopify's `customer_selection: 'all'`.
  The `type`/`value` strings are written in the seed-parseable format
  (`"10%"`, `"free shipping"`, `"$10.00"`) as belt-and-braces alongside
  the explicit detail fields (explicit fields win in `normalizeDiscount`).
- `redeem-reward` rewrite: delete `shopifyCreateCode`, `shopifyDeleteRule`,
  `resolveShopifyToken`, `SHOPIFY_*` env reads, and the pool route (pool
  codes are Shopify codes — dead at lapse; drawing one post-cutover would
  hand the user a code the checkout rejects). New order: (a) Cloudflare
  mint → delivery `'cloudflare'`; (b) manual claim code → delivery
  `'manual'`, used ONLY for `free_product` (Free Tee). If minting fails
  for a code reward, return 502 with points NOT deducted (same semantics
  as today's Shopify-create failure) — never silently fall through to a
  manual code the checkout cannot honor. Mint-code collision (409) retries
  once with a fresh code. JWT auth, idempotency replay, pre-checks,
  `complete_redemption()` call, and Resend email are unchanged; the email
  copy ("Enter it at checkout on beatrackfam.info") stays true.
- App-side edits (comments only, no behavior change): `earn.tsx` Shopify
  webhook comments → Cloudflare trigger pointer; `loyalty.ts` header
  comment → Cloudflare mint description. The Rewards tab copy ("Show or
  enter this code at checkout") stays true.

## Build part 3 — app repo hygiene (no behavior change)

- Commit `supabase/functions/cloudflare-order/` (new file, already written).
- Update `supabase/README.md` setup docs: replace the Shopify Dev
  Dashboard app + `code_pool` stocking instructions with the Cloudflare
  mint endpoint + shared-secret setup.
- Leave `shopify-order` in place until cutover (it dies on its own when
  Shopify lapses; deleting the function is a post-cutover cleanup, not a
  rebuild step).
- Do NOT touch the Motivation app, the demo account, or any password.

## Version proposal — for Joey's call (not applied by this build)

Current state is muddled: `app.json` already says version `2.0`,
iOS buildNumber 20 (the pulled build), Android versionCode 9, while
`package.json` still says 1.0.0 and the ASC record is v1.0. Rewards
build numbers move +1 per store upload (NOT +100 like the main app).
Proposed next release: **2.0 (21) iOS / 2.0 (10) Android** — unifies on
the `app.json` 2.0 already in the tree and follows the +1 rule on both
platforms. Alternative: 1.0 (21) iOS keeps the ASC v1.0 lineage but
diverges from `app.json` 2.0 and from Android. Joey decides; the build
does not bump anything until he does.

## Deploy / secret checklist (parent-side, in order)

1. Rewards repo: review + push the local commits (NOT done by this build).
2. Supabase: deploy `cloudflare-order` + the rewritten `redeem-reward`;
   set `REWARDS_TRIGGER_SECRET` (Supabase function secret).
3. Cloudflare: set Worker secrets `REWARDS_WEBHOOK_URL` +
   `REWARDS_TRIGGER_SECRET`; redeploy the Worker (activates the trigger
   AND ships the mint endpoint).
4. Verify: points smoke test (§1 step 3); redemption test with a
   low-cost reward on a test profile (mint → checkout validate →
   confirm the code applies once and rejects on second use).
5. Submission (separate yes): iOS workflow `upload_to_testflight`
   (default on) → TestFlight → App Store review; Android workflow
   `upload_to_play` (default off) → Play production. NOTE: the main-app
   standing rule (upload_to_play ON for future Android runs) was set in
   the main-app context — confirm whether it extends to Rewards runs
   before the first Rewards Android dispatch.

## Deploy-tree caveat (read before the next Worker deploy)

The mint endpoint + test-skip fix are edits inside
`~/workspace/beatrackfam-migration/` (which is NOT a git repo — changes
there cannot be committed, only reviewed as working-tree diffs). The
mint endpoint sits in `prod-deploy/src/storefront-api.js`, which IS the
deploy tree: the next `wrangler deploy` from `prod-deploy/` ships it.
Review those two diffs before deploying; nothing in this build deploys
anything on its own.

## Verification done by this build (no live testing possible yet)

- `tsc --noEmit` clean on the Rewards app (no lint script exists in this
  repo — typecheck is the gate).
- Syntax check on the edited Deno functions and Worker files.
- Contract check: backend trigger payload vs `cloudflare-order` input
  (exact match); mint output vs `evaluateDiscount` input (explicit
  detail fields + parseable strings); `complete_redemption` accepts the
  new `'cloudflare'` delivery value with no SQL change.
- NOT verified live (needs deploy + secrets): trigger end-to-end,
  mint → checkout-apply → second-use rejection, Resend email on the new
  path. Those are step 4 of the checklist above.
