/**
 * Cloudflare storefront order → award loyalty points on successful payment.
 *
 * Server-to-server replacement for the Shopify `orders/paid` webhook
 * (supabase/functions/shopify-order), which dies when Shopify lapses
 * (Nov 16, 2026). The Cloudflare storefront backend calls this endpoint
 * ONLY after a payment is approved/accepted/processed — never from any
 * app, and never at page load.
 *
 * Request: POST with JSON {"order_number","email","amount_cents"} and
 * header `Authorization: Bearer <secret>`, where the secret is the
 * REWARDS_TRIGGER_SECRET env var, set to the same value on both sides.
 *
 * Behavior mirrors shopify-order exactly:
 * - 25 pts per paid order, flat, regardless of amount_cents.
 * - Idempotent via points_ledger.action_id = 'cloudflare-order-<order_number>'.
 * - Matches the order email to an existing loyalty profile; if no profile
 *   exists, nothing is created and no points are granted.
 * - Ledger insert first, then profile balance update (same two-step
 *   pattern as shopify-order — not a single DB transaction).
 *
 * SETUP (in Supabase dashboard / CLI, by the parent — no secrets here):
 * 1. Deploy ONLY this function (never touch shopify-order until cutover).
 * 2. Set secret REWARDS_TRIGGER_SECRET (same value as the Cloudflare side).
 *    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already set for the
 *    existing functions.
 * 3. Cloudflare side: set REWARDS_WEBHOOK_URL to
 *    https://<project>.supabase.co/functions/v1/cloudflare-order
 *    and REWARDS_TRIGGER_SECRET to the same secret value.
 *
 * Points are ONLY granted on a call from the Cloudflare backend carrying
 * the correct bearer secret — never from an app, and never without auth.
 */

const POINTS_PER_ORDER = 25;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  // Fail closed: if the secret is not configured, reject everything.
  // The secret value is never logged.
  const secret = Deno.env.get('REWARDS_TRIGGER_SECRET');
  if (!secret) {
    return json({ ok: false, error: 'trigger_secret_not_configured' }, 500);
  }

  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token || !timingSafeEqual(token, secret)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'malformed_json' }, 400);
  }

  const orderNumber =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).order_number
      : undefined;
  const email =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).email
      : undefined;
  const amountCents =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).amount_cents
      : undefined;

  if (
    typeof orderNumber !== 'string' ||
    orderNumber.trim() === '' ||
    typeof email !== 'string' ||
    email.trim() === '' ||
    typeof amountCents !== 'number' ||
    !Number.isInteger(amountCents)
  ) {
    return json({ ok: false, error: 'invalid_input' }, 400);
  }

  // amount_cents is validated but does NOT change the grant: points stay
  // flat at 25 per paid order, exactly like shopify-order.

  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Idempotency: one grant per Cloudflare order number. Checked before
  // the profile lookup, same order as shopify-order.
  const actionId = `cloudflare-order-${orderNumber}`;
  const { data: existing } = await supabase
    .from('points_ledger')
    .select('id')
    .eq('action_id', actionId)
    .limit(1);
  if (existing && existing.length > 0) {
    return json({ ok: true, credited: false, reason: 'already_credited' }, 200);
  }

  // Match the order email to a loyalty profile — same lookup as
  // shopify-order (exact email match). No profile is ever created here.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, points')
    .eq('email', email)
    .limit(1)
    .single();
  if (!profile) {
    // Customer isn't a loyalty member — nothing to credit.
    return json({ ok: true, credited: false, reason: 'no_profile' }, 200);
  }

  const { error } = await supabase.from('points_ledger').insert({
    user_id: profile.id,
    delta: POINTS_PER_ORDER,
    reason: `Order ${orderNumber} paid at beatrackfam.info`,
    action_id: actionId,
  });
  if (error) {
    // Unique-violation race: a concurrent retry already inserted the row.
    if ((error as { code?: string }).code === '23505') {
      return json({ ok: true, credited: false, reason: 'already_credited' }, 200);
    }
    console.error('Ledger insert failed:', error.message);
    return json({ ok: false, error: 'ledger_write_failed' }, 500);
  }

  await supabase
    .from('profiles')
    .update({ points: (profile.points ?? 0) + POINTS_PER_ORDER })
    .eq('id', profile.id);

  return json({ ok: true, credited: true }, 200);
});
