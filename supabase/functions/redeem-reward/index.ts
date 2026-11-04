/**
 * Redeem reward → mint ONE real, single-use coupon code for the caller.
 *
 * Cloudflare rebuild (Nov 4, 2026). Every redemption is a server-side,
 * account-keyed record (public.redemptions) created exactly once:
 *
 *   1. The caller is identified from their Supabase Auth JWT — never a
 *      user id from the request body.
 *   2. Idempotency: the app sends a client-generated idempotency key per
 *      redemption attempt. A replayed key returns the ORIGINAL redemption
 *      (same code, no second deduction) — double-taps, retries, and
 *      reinstalls can never re-mint or double-charge.
 *   3. A real code is produced by one of two routes, in order:
 *      a. CLOUDFLARE (preferred): created in the Cloudflare store's D1
 *         discount catalog via POST /api/rewards/mint-code (single-use,
 *         max_uses_total=1, enforced by checkout usage counting), when
 *         REWARDS_TRIGGER_SECRET is set — the same shared secret value
 *         the Worker uses for the order-paid points trigger. A mint
 *         failure returns 502 with points NOT deducted; it never falls
 *         through to a manual code the checkout cannot honor.
 *      b. MANUAL: an internal claim code, used ONLY for the Free Tee
 *         (no D1 equivalent for a free product — the store already
 *         emails the customer to confirm size, per the reward's
 *         description). The old Shopify pool route is retired:
 *         code_pool rows are pre-created Shopify codes, worthless
 *         after the Shopify lapse, so drawing one would hand the user
 *         a code the checkout rejects.
 *   4. complete_redemption() records it atomically (points deducted
 *      exactly once; birthday claims guarded per BIRTHDAY_CYCLE='yearly'
 *      by CLAIM HISTORY — editing the birthday field never resets it).
 *      If recording fails after a Cloudflare code was minted, the code
 *      is deleted again (best effort) so no orphan codes live. The
 *      function needs no SQL change for the new route:
 *      complete_redemption() accepts any delivery string and only
 *      draws from code_pool when delivery = 'pool'.
 *   5. The code is emailed to the account's email via Resend when
 *      RESEND_API_KEY is set, and stamped on the redemption row. The
 *      in-app redemption history works with or without email.
 *
 * SETUP (Joey, in the Supabase dashboard):
 * 1. Run supabase/migration_redemptions_v2.sql in the SQL Editor, then
 *    re-run supabase/seed.sql (adds the birthday reward + mappings).
 * 2. Deploy this function: Edge Functions → deploy `redeem-reward`
 *    (or `supabase functions deploy redeem-reward`).
 * 3. Cloudflare mint codes: set the Edge Function secret
 *    REWARDS_TRIGGER_SECRET to the SAME value as the Cloudflare Worker
 *    secret of the same name (the Worker endpoint
 *    POST /api/rewards/mint-code checks that bearer). The store base
 *    URL defaults to https://beatrackfam.info; override with
 *    CLOUDFLARE_STORE_URL only if the store ever moves domains.
 * 4. Optional — code emails: create a Resend account, verify the
 *    beatrackfam.info domain, and set secrets:
 *      RESEND_API_KEY=<key>
 *      RESEND_FROM_EMAIL=BeaTrackFam Rewards <rewards@beatrackfam.info>
 *    (RESEND_FROM_EMAIL optional; the default above is used otherwise.)
 */

// Mirror of lib/loyalty.ts BIRTHDAY_CYCLE — policy is ENFORCED in SQL
// (complete_redemption); this constant is documentation for this layer.
const BIRTHDAY_CYCLE = 'yearly';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mintCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) suffix += chars[b % chars.length];
  return `BTF-${suffix}`;
}

interface RewardRow {
  id: string;
  title: string;
  cost: number;
  kind: string;
  discount_kind: string | null;
  discount_value: number | null;
  min_subtotal: number | null;
  active: boolean;
}

/** Mint a single-use discount code in the Cloudflare store (D1
 * catalog_discounts via POST /api/rewards/mint-code). Auth is the
 * shared REWARDS_TRIGGER_SECRET bearer — the same secret value the
 * Worker uses for the order-paid points trigger. Throws on any
 * failure; the caller turns it into a 502 with points untouched. */
async function cloudflareMintCode(
  reward: RewardRow,
  code: string,
): Promise<void> {
  const secret = Deno.env.get('REWARDS_TRIGGER_SECRET');
  if (!secret) {
    throw new Error('REWARDS_TRIGGER_SECRET is not configured');
  }
  const base = (Deno.env.get('CLOUDFLARE_STORE_URL') ?? 'https://beatrackfam.info')
    .replace(/\/$/, '');
  const res = await fetch(`${base}/api/rewards/mint-code`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      discount_kind: reward.discount_kind,
      discount_value: reward.discount_value,
      min_subtotal: reward.min_subtotal,
    }),
  });
  if (res.status === 409) {
    throw Object.assign(new Error('code already exists'), { code: 'CONFLICT' });
  }
  if (!res.ok) {
    throw new Error(`Cloudflare mint failed (${res.status})`);
  }
}

/** Best-effort rollback for a minted code whose redemption recording
 * failed — mirrors the old Shopify price-rule delete. */
async function cloudflareDeleteCode(code: string): Promise<void> {
  const secret = Deno.env.get('REWARDS_TRIGGER_SECRET');
  if (!secret) return;
  const base = (Deno.env.get('CLOUDFLARE_STORE_URL') ?? 'https://beatrackfam.info')
    .replace(/\/$/, '');
  await fetch(`${base}/api/rewards/mint-code?code=${encodeURIComponent(code)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}` },
  }).catch(() => {});
}

async function sendCodeEmail(
  rewardTitle: string,
  code: string,
  toEmail: string,
): Promise<boolean> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return false;
  const from = Deno.env.get('RESEND_FROM_EMAIL')
    ?? 'BeaTrackFam Rewards <rewards@beatrackfam.info>';
  const text = [
    `You redeemed: ${rewardTitle}`,
    '',
    `Your single-use code: ${code}`,
    '',
    'Enter it at checkout on beatrackfam.info. It works once — and it lives',
    'in your Fam Rewards app under Rewards → MY CODES if you ever lose this',
    'email.',
    '',
    'Loyalty above all.',
    '— BeaTrackFam',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;background:#000;color:#fff;padding:32px;border-radius:16px">
    <p style="letter-spacing:3px;color:#999;font-size:12px">BEATRACKFAM REWARDS</p>
    <h1 style="font-size:24px;margin:8px 0">${rewardTitle}</h1>
    <p style="color:#ccc">Your single-use code:</p>
    <p style="background:#fff;color:#000;font-size:28px;font-weight:800;letter-spacing:4px;padding:14px 20px;border-radius:12px;display:inline-block">${code}</p>
    <p style="color:#ccc;line-height:1.6">Enter it at checkout on beatrackfam.info. It works once — and it lives in your Fam Rewards app under <b>Rewards → MY CODES</b> if you ever lose this email.</p>
    <p style="color:#999">Loyalty above all.<br/>— BeaTrackFam</p>
  </div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject: `Your BeaTrackFam code: ${rewardTitle}`,
        text,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'Missing or invalid authorization header' });
  }

  let body: { reward_id?: string; idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid request body' });
  }
  const rewardId = body.reward_id;
  const idempotencyKey = body.idempotency_key;
  if (!rewardId || !idempotencyKey) {
    return json(400, { error: 'reward_id and idempotency_key are required' });
  }

  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (!url || !anonKey || !serviceRoleKey) {
    return json(500, { error: 'Function is not configured' });
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return json(401, { error: 'Could not verify your session — please sign in again' });
  }
  const userId = userData.user.id;

  const admin = createClient(url, serviceRoleKey);

  const okPayload = async (row: any, title: string) => {
    // Email on first completion — and on replays where the original send
    // never landed — never more than once per redemption.
    let emailSent = !!row.email_sent_at;
    if (!emailSent && row.email) {
      emailSent = await sendCodeEmail(title, row.code, row.email);
      if (emailSent) {
        await admin
          .from('redemptions')
          .update({ email_sent_at: new Date().toISOString() })
          .eq('id', row.id);
      }
    }
    return json(200, {
      ok: true,
      redemption_id: row.id,
      code: row.code,
      reward_title: title,
      email_sent: emailSent,
    });
  };

  // Idempotent replay: return the original redemption untouched.
  const { data: prior } = await admin
    .from('redemptions')
    .select('id, code, email, email_sent_at, reward_id')
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (prior) {
    const { data: priorReward } = await admin
      .from('rewards')
      .select('title')
      .eq('id', prior.reward_id)
      .maybeSingle();
    return okPayload(prior, priorReward?.title ?? 'Reward');
  }

  // Load reward + profile for pre-checks (complete_redemption re-checks
  // everything authoritatively under a row lock).
  const { data: reward } = await admin
    .from('rewards')
    .select('id, title, cost, kind, discount_kind, discount_value, min_subtotal, active')
    .eq('id', rewardId)
    .maybeSingle();
  if (!reward || !reward.active) {
    return json(404, { error: 'reward not found or inactive' });
  }
  const { data: profile } = await admin
    .from('profiles')
    .select('id, email, points, birthday')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return json(404, { error: 'no profile for user' });

  if (reward.cost > 0 && (profile.points ?? 0) < reward.cost) {
    return json(400, { error: 'insufficient points' });
  }
  if (reward.kind === 'birthday') {
    if (!profile.birthday) return json(400, { error: 'birthday not set' });
    const { data: claimed } = await admin
      .from('redemptions')
      .select('id, rewards!inner(kind)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('rewards.kind', 'birthday')
      .gt('created_at', new Date(Date.now() - 365.25 * 24 * 3600 * 1000).toISOString())
      .limit(1);
    if (claimed && claimed.length > 0) {
      return json(409, { error: 'birthday already claimed this cycle' });
    }
  }

  // Pick the delivery route. Code rewards (percent / shipping / amount)
  // mint a real single-use D1 code in the Cloudflare store; a mint
  // failure returns 502 with points NOT deducted — never a manual code
  // the checkout cannot honor. Free Tee has no D1 equivalent and stays
  // a manual claim code (email to confirm size).
  const mintable = reward.discount_kind === 'percent'
    || reward.discount_kind === 'shipping'
    || reward.discount_kind === 'amount';

  let delivery: 'cloudflare' | 'manual' = 'manual';
  let code: string | null = null;

  if (mintable) {
    code = mintCode();
    try {
      await cloudflareMintCode(reward as RewardRow, code);
      delivery = 'cloudflare';
    } catch (e) {
      if ((e as { code?: string }).code === 'CONFLICT') {
        // Extremely unlikely random-code collision: one fresh retry.
        code = mintCode();
        try {
          await cloudflareMintCode(reward as RewardRow, code);
          delivery = 'cloudflare';
        } catch (e2) {
          console.error('Cloudflare code mint failed:', (e2 as Error).message);
          return json(502, {
            error: 'Could not create your code in the store — points were not deducted. Try again.',
          });
        }
      } else {
        console.error('Cloudflare code mint failed:', (e as Error).message);
        return json(502, {
          error: 'Could not create your code in the store — points were not deducted. Try again.',
        });
      }
    }
  } else {
    delivery = 'manual';
    code = mintCode();
  }

  // Record it — atomically, exactly once.
  const { data: row, error: rpcError } = await admin.rpc('complete_redemption', {
    p_user_id: userId,
    p_reward_id: rewardId,
    p_idempotency_key: idempotencyKey,
    p_code: code,
    p_delivery: delivery,
  });
  if (rpcError || !row) {
    if (delivery === 'cloudflare' && code) {
      await cloudflareDeleteCode(code);
    }
    const msg = (rpcError?.message ?? '').toLowerCase();
    if (msg.includes('insufficient points')) return json(400, { error: 'insufficient points' });
    if (msg.includes('birthday')) {
      return json(409, { error: msg.includes('not set') ? 'birthday not set' : 'birthday already claimed this cycle' });
    }
    if (msg.includes('not found')) return json(404, { error: 'reward not found or inactive' });
    console.error('complete_redemption failed:', rpcError?.message);
    return json(500, { error: 'Could not complete the redemption. Try again.' });
  }

  return okPayload(row, reward.title);
});
