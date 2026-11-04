# BeaTrackFam Rewards — backend setup

How to set up the app's database and keys. Do this once, in order.

1. **Create your Supabase project**
   - Go to [supabase.com](https://supabase.com) and sign up / sign in (free tier is fine).
   - Click **New project**, name it something like `beatrackfam-rewards`, and save the database password somewhere safe.
   - Wait for it to finish setting up (takes about a minute).

2. **Run the schema**
   - In the Supabase dashboard, open **SQL Editor** from the left sidebar.
   - Open the file `supabase/schema.sql` on your computer, copy everything in it.
   - Paste it into the SQL Editor and click **Run**.
   - It should finish with no errors. You can run it again any time — it's safe.

3. **Add the launch rewards**
   - Still in the SQL Editor, clear it.
   - Copy everything in `supabase/seed.sql`, paste it, and click **Run**.
   - This adds the 4 starting rewards (10% off, free shipping, $10 off, free tee).

3b. **Add push-token storage** (one more small file)
   - Clear the editor again, copy everything in `supabase/migration_push_token.sql`, paste, and click **Run**.
   - This adds the `push_token` column so the app can send you reward/drop alerts.

3c. **Build 19: redemption overhaul + Edit Profile** (one more file)
   - Clear the editor again, copy everything in `supabase/migration_redemptions_v2.sql`, paste, and click **Run**.
   - Then re-run `supabase/seed.sql` (step 3) — it now also adds the Birthday 10% Off reward and each reward's store-discount mapping.
   - This makes every redemption a server record with a real, single-use store code that is emailed to the member and kept in their in-app MY CODES history. A completed redemption is final — it cannot be re-minted by reinstalling the app. It also adds display names, profile photos (avatars bucket), and the birthday cycle guard.
   - Heads-up: after this runs, the OLD app (build 18 and earlier) can no longer redeem — it minted codes the store never honored. Build 19 replaces it.

3d. **Deploy the redeem function**
   - In the Supabase dashboard, go to **Edge Functions** and deploy the `redeem-reward` function from `supabase/functions/redeem-reward/` (or run `supabase functions deploy redeem-reward`).
   - Also re-deploy `delete-account` — build 19's version also removes the member's stored profile photo.
   - No secrets are required for the Free Tee claim codes to work, but
     two upgrades are one step each:
     - **Live Cloudflare codes** (recommended, Nov 4, 2026 rebuild):
       every code reward (10% Off, Free Shipping, $10 Off, Birthday 10%
       Off) mints a real single-use D1 discount in the Cloudflare store
       via `POST /api/rewards/mint-code`. Set the Edge Function secret
       `REWARDS_TRIGGER_SECRET` to the SAME value as the Cloudflare
       Worker secret of the same name. The old Shopify live-code setup
       (`SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_CLIENT_ID` /
       `SHOPIFY_CLIENT_SECRET` / `SHOPIFY_ADMIN_ACCESS_TOKEN`) and the
       `code_pool` stocking path are retired — pool rows are Shopify
       codes the Cloudflare checkout cannot honor.
     - **Code emails**: create a Resend account, verify the `beatrackfam.info` domain, and set the Edge Function secret `RESEND_API_KEY`. Optionally set `RESEND_FROM_EMAIL` (default `BeaTrackFam Rewards <rewards@beatrackfam.info>`). Until then, codes still appear instantly in the app under Rewards → MY CODES.
     - **Free Tee**: always a manual claim code — the store emails the
       member to confirm size, as its description says. There is no D1
       equivalent for a free product.

4. **Copy your keys into the app**
   - In the Supabase dashboard, go to **Project Settings → API**.
   - Copy the **Project URL** and the **anon public** key.
   - Paste them into the app's `.env` file as `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

That's it — the app will handle sign-ups, points, tiers, and redemptions from here.
