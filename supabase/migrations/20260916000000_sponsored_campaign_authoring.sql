-- Merchant-authored sponsored campaign requests. Pricing and activation remain
-- server-authoritative; this migration never enables charging or ad serving.

alter table public.ad_campaigns
  add column if not exists request_key_hash char(64),
  add column if not exists request_hash char(64);

alter table public.ad_campaigns
  drop constraint if exists ad_campaigns_request_hashes,
  add constraint ad_campaigns_request_hashes check (
    (request_key_hash is null and request_hash is null)
    or (request_key_hash ~ '^[0-9a-f]{64}$' and request_hash ~ '^[0-9a-f]{64}$')
  );

create unique index if not exists ad_campaigns_creator_request_key_idx
  on public.ad_campaigns (created_by, request_key_hash)
  where request_key_hash is not null;

create or replace function public.get_sponsored_campaign_quote(target_business_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); quote record;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  perform private.consume_rate_limit(actor, 'sponsor_quote_hour', 60, 3600);
  select business.name, pricing.id as pricing_id, pricing.version, pricing.currency,
    pricing.click_floor_minor, pricing.click_ceiling_minor,
    greatest(15000::bigint, pricing.click_floor_minor::bigint * 30) as minimum_monthly_minor,
    location.region
  into quote
  from public.businesses business
  join public.business_members member on member.business_id = business.id
    and member.user_id = actor and member.status = 'active' and member.role in ('owner', 'manager')
  join public.business_locations location on location.business_id = business.id
    and location.publication_state = 'published' and location.point is not null
    and location.public_address and not location.is_approximate
  join public.pricing_versions pricing on pricing.currency = 'USD'
    and pricing.state = 'approved' and pricing.effective_at <= now()
    and (pricing.expires_at is null or pricing.expires_at > now())
    and greatest(15000::bigint, pricing.click_floor_minor::bigint * 30) <= 300000
    and upper(pricing.region_code) in ('GLOBAL', 'US', upper(location.region))
  where business.id = target_business_id and business.verification = 'verified'
    and private.is_business_publicly_eligible(business.id)
  order by case upper(pricing.region_code)
    when upper(location.region) then 0 when 'US' then 1 else 2 end,
    pricing.effective_at desc, location.is_primary desc
  limit 1;
  if quote.pricing_id is null then return null; end if;
  return jsonb_build_object(
    'business_name', quote.name,
    'pricing_version', quote.version,
    'currency', quote.currency,
    'minimum_monthly_minor', quote.minimum_monthly_minor,
    'maximum_monthly_minor', greatest(quote.minimum_monthly_minor,
      least(300000::bigint, quote.click_ceiling_minor::bigint * 400)),
    'billing_event', 'qualified sponsored open',
    'term_days', 30,
    'disclosure', 'Sponsored ad'
  );
end;
$$;

create or replace function public.create_sponsored_campaign_draft(
  target_business_id uuid,
  monthly_budget_minor integer,
  radius_meters integer,
  campaign_starts_at timestamptz,
  idempotency_key text
)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); business_row record; pricing_row public.pricing_versions%rowtype;
  location_row record; campaign_id uuid; campaign_public_id uuid; prior_hash text;
  key_hash text; payload_hash text; bid_minor integer; daily_minor integer;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  if target_business_id is null
    or monthly_budget_minor is null
    or radius_meters is null
    or campaign_starts_at is null
    or idempotency_key is null
    or monthly_budget_minor not between 15000 and 300000
    or radius_meters not between 1609 and 80467
    or campaign_starts_at < now() + interval '15 minutes'
    or campaign_starts_at > now() + interval '60 days'
    or idempotency_key !~ '^spottr:sponsor:[A-Za-z0-9._:-]{12,180}$'
  then raise exception using errcode = '22023', message = 'Invalid campaign request'; end if;

  select business.id, business.kind, business.name, business.cuisine_labels
  into business_row from public.businesses business
  join public.business_members member on member.business_id = business.id
    and member.user_id = actor and member.status = 'active' and member.role in ('owner', 'manager')
  where business.id = target_business_id and business.verification = 'verified'
    and private.is_business_publicly_eligible(business.id);
  if business_row.id is null then
    raise exception using errcode = '42501', message = 'Verified owner or manager required';
  end if;

  select location.point, location.region into location_row
  from public.business_locations location
  where location.business_id = target_business_id and location.publication_state = 'published'
    and location.point is not null and location.public_address and not location.is_approximate
  order by location.is_primary desc, location.updated_at desc limit 1;
  if location_row.point is null then
    raise exception using errcode = '22023', message = 'A verified public business location is required';
  end if;

  select pricing.* into pricing_row from public.pricing_versions pricing
  where pricing.currency = 'USD' and pricing.state = 'approved' and pricing.effective_at <= now()
    and (pricing.expires_at is null or pricing.expires_at > now())
    and greatest(15000::bigint, pricing.click_floor_minor::bigint * 30) <= 300000
    and upper(pricing.region_code) in ('GLOBAL', 'US', upper(location_row.region))
  order by case upper(pricing.region_code)
    when upper(location_row.region) then 0 when 'US' then 1 else 2 end,
    pricing.effective_at desc limit 1;
  if pricing_row.id is null or monthly_budget_minor < greatest(15000::bigint, pricing_row.click_floor_minor::bigint * 30) then
    raise exception using errcode = '22023', message = 'Approved campaign pricing is unavailable';
  end if;

  key_hash := private.ad_sha256_hex(idempotency_key);
  payload_hash := private.ad_sha256_hex(concat_ws('|', target_business_id, monthly_budget_minor,
    radius_meters, campaign_starts_at, pricing_row.id));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text || key_hash, 916160));
  select campaign.public_id, campaign.request_hash into campaign_public_id, prior_hash
  from public.ad_campaigns campaign
  where campaign.created_by = actor and campaign.request_key_hash = key_hash;
  if campaign_public_id is not null then
    if prior_hash <> payload_hash then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return campaign_public_id;
  end if;
  perform private.consume_rate_limit(actor, 'sponsor_draft_day', 10, 86400);

  bid_minor := least(pricing_row.click_ceiling_minor,
    greatest(pricing_row.click_floor_minor, monthly_budget_minor / 200));
  daily_minor := greatest(bid_minor, (monthly_budget_minor + 29) / 30);
  insert into public.ad_campaigns (
    business_id, objective, billing_model, state, currency, bid_cap_minor,
    daily_budget_minor, lifetime_budget_minor, pricing_version_id, starts_at,
    ends_at, created_by, request_key_hash, request_hash
  ) values (
    target_business_id, 'discovery', 'shadow', 'draft', 'USD', bid_minor,
    daily_minor, monthly_budget_minor, pricing_row.id, campaign_starts_at,
    campaign_starts_at + interval '30 days', actor, key_hash, payload_hash
  ) returning id, public_id into campaign_id, campaign_public_id;

  insert into public.ad_targets (
    campaign_id, business_kinds, cuisine_labels, center, radius_meters
  ) values (
    campaign_id, array[business_row.kind]::public.business_kind[],
    coalesce(business_row.cuisine_labels, '{}'::text[]), location_row.point, radius_meters
  );
  insert into public.ad_creatives (
    campaign_id, business_id, media_asset_id, moderation, moderation_version
  ) values (campaign_id, target_business_id, null, 'approved', 'verified-listing-v1');
  perform private.write_audit_event(actor, target_business_id, 'sponsor.campaign_draft_created',
    'ad_campaign', campaign_id::text,
    jsonb_build_object('public_id', campaign_public_id, 'monthly_budget_minor', monthly_budget_minor,
      'currency', 'USD', 'pricing_version', pricing_row.version));
  return campaign_public_id;
end;
$$;

create or replace function public.submit_sponsored_campaign(
  target_campaign_public_id uuid, expected_updated_at timestamptz
)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); target record;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  select campaign.id, campaign.business_id, campaign.state, campaign.updated_at,
    campaign.starts_at, campaign.ends_at, campaign.pricing_version_id,
    campaign.currency, campaign.lifetime_budget_minor
  into target
  from public.ad_campaigns campaign join public.business_members member
    on member.business_id = campaign.business_id and member.user_id = actor
    and member.status = 'active' and member.role in ('owner', 'manager')
  join public.businesses business on business.id = campaign.business_id
  where campaign.public_id = target_campaign_public_id and business.verification = 'verified'
    and private.is_business_publicly_eligible(business.id) for update of campaign;
  if target.id is null then raise exception using errcode = '42501', message = 'Campaign access denied'; end if;
  if target.state <> 'draft' or target.updated_at is distinct from expected_updated_at then
    raise exception using errcode = '40001', message = 'Campaign changed; refresh and try again';
  end if;
  if target.starts_at <= now() or target.ends_at <= now()
    or not exists (
      select 1 from public.pricing_versions pricing
      where pricing.id = target.pricing_version_id
        and pricing.currency = target.currency
        and pricing.state = 'approved'
        and pricing.effective_at <= now()
        and (pricing.expires_at is null or pricing.expires_at > now())
        and target.lifetime_budget_minor >= greatest(15000::bigint, pricing.click_floor_minor::bigint * 30)
        and target.lifetime_budget_minor <= greatest(
          greatest(15000::bigint, pricing.click_floor_minor::bigint * 30),
          least(300000::bigint, pricing.click_ceiling_minor::bigint * 400)
        )
    )
    or not exists (
      select 1 from public.business_locations location
      where location.business_id = target.business_id
        and location.publication_state = 'published'
        and location.point is not null
        and location.public_address
        and not location.is_approximate
    )
  then raise exception using errcode = '22023', message = 'Campaign pricing, dates, or location must be refreshed'; end if;
  if not exists (select 1 from public.ad_targets where campaign_id = target.id)
    or not exists (select 1 from public.ad_creatives where campaign_id = target.id and moderation = 'approved')
  then raise exception using errcode = '22023', message = 'Campaign setup is incomplete'; end if;
  perform private.consume_rate_limit(actor, 'sponsor_submit_day', 8, 86400);
  update public.ad_campaigns set state = 'submitted', updated_at = now() where id = target.id;
  perform private.write_audit_event(actor, target.business_id, 'sponsor.campaign_submitted',
    'ad_campaign', target.id::text, '{}'::jsonb);
  return 'submitted';
end;
$$;

create or replace function public.end_sponsored_campaign(
  target_campaign_public_id uuid, expected_updated_at timestamptz
)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); target record;
begin
  perform private.require_aal2();
  if not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active verified account required';
  end if;
  select campaign.id, campaign.business_id, campaign.state, campaign.updated_at into target
  from public.ad_campaigns campaign join public.business_members member
    on member.business_id = campaign.business_id and member.user_id = actor
    and member.status = 'active' and member.role in ('owner', 'manager')
  where campaign.public_id = target_campaign_public_id for update of campaign;
  if target.id is null then raise exception using errcode = '42501', message = 'Campaign access denied'; end if;
  if target.state not in ('draft', 'submitted', 'active', 'paused')
    or target.updated_at is distinct from expected_updated_at
  then raise exception using errcode = '40001', message = 'Campaign changed; refresh and try again'; end if;
  perform private.consume_rate_limit(actor, 'sponsor_end_day', 20, 86400);
  update public.ad_campaigns set state = 'ended', updated_at = now() where id = target.id;
  perform private.write_audit_event(actor, target.business_id, 'sponsor.campaign_ended',
    'ad_campaign', target.id::text, jsonb_build_object('prior_state', target.state));
  return 'ended';
end;
$$;

revoke all on function public.get_sponsored_campaign_quote(uuid) from public, anon, service_role;
revoke all on function public.create_sponsored_campaign_draft(uuid, integer, integer, timestamptz, text) from public, anon, service_role;
revoke all on function public.submit_sponsored_campaign(uuid, timestamptz) from public, anon, service_role;
revoke all on function public.end_sponsored_campaign(uuid, timestamptz) from public, anon, service_role;
grant execute on function public.get_sponsored_campaign_quote(uuid) to authenticated;
grant execute on function public.create_sponsored_campaign_draft(uuid, integer, integer, timestamptz, text) to authenticated;
grant execute on function public.submit_sponsored_campaign(uuid, timestamptz) to authenticated;
grant execute on function public.end_sponsored_campaign(uuid, timestamptz) to authenticated;

-- Promotion budgets and performance are owner/manager financial data. Replace
-- the broader foundation reads before merchant-authored campaigns are exposed.
drop policy if exists "members read campaign pricing" on public.pricing_versions;
create policy "owners and managers read campaign pricing" on public.pricing_versions
  for select to authenticated using (
    private.has_aal2() and exists (
      select 1 from public.ad_campaigns campaign
      join public.business_members member on member.business_id = campaign.business_id
        and member.user_id = auth.uid() and member.status = 'active'
        and member.role in ('owner', 'manager')
      where campaign.pricing_version_id = pricing_versions.id
    )
  );

drop policy if exists "members read campaigns" on public.ad_campaigns;
create policy "owners and managers read campaigns" on public.ad_campaigns
  for select to authenticated using (
    private.has_aal2() and exists (
      select 1 from public.business_members member
      where member.business_id = ad_campaigns.business_id
        and member.user_id = auth.uid() and member.status = 'active'
        and member.role in ('owner', 'manager')
    )
  );

drop policy if exists "members read campaign targets" on public.ad_targets;
create policy "owners and managers read campaign targets" on public.ad_targets
  for select to authenticated using (
    private.has_aal2() and exists (
      select 1 from public.ad_campaigns campaign
      join public.business_members member on member.business_id = campaign.business_id
        and member.user_id = auth.uid() and member.status = 'active'
        and member.role in ('owner', 'manager')
      where campaign.id = ad_targets.campaign_id
    )
  );

drop policy if exists "members read campaign creatives" on public.ad_creatives;
create policy "owners and managers read campaign creatives" on public.ad_creatives
  for select to authenticated using (
    private.has_aal2() and exists (
      select 1 from public.business_members member
      where member.business_id = ad_creatives.business_id
        and member.user_id = auth.uid() and member.status = 'active'
        and member.role in ('owner', 'manager')
    )
  );

drop policy if exists "members read campaign rollups" on public.ad_campaign_daily_rollups;
create policy "owners and managers read campaign rollups" on public.ad_campaign_daily_rollups
  for select to authenticated using (
    private.has_aal2() and exists (
      select 1 from public.ad_campaigns campaign
      join public.business_members member on member.business_id = campaign.business_id
        and member.user_id = auth.uid() and member.status = 'active'
        and member.role in ('owner', 'manager')
      where campaign.id = ad_campaign_daily_rollups.campaign_id
    )
  );

do $verify_hash$
begin
  if private.ad_sha256_hex('spottr-sponsor-authoring') !~ '^[0-9a-f]{64}$' then
    raise exception 'Sponsored authoring SHA-256 helper is unavailable';
  end if;
end;
$verify_hash$;
