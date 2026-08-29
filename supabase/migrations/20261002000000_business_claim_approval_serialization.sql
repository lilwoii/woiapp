-- Serialize business-claim approvals against ownership changes and business-row
-- lifecycle transitions. The business row is locked before the claim row so
-- competing approvals and state/provenance updates that use the same row lock
-- cannot approve two claims (or approve a claim after an owner already exists).
-- Provider account/source eligibility remains a point-in-time recheck: taking
-- child locks here would invert the established provider ingest lock order.
--
-- The verification-receipt trigger remains the final fail-closed approval
-- gate. This migration only hardens the approval transaction for the future
-- verified claim service; it does not enable the client feature or any launch
-- flag. Rejections remain available even when an approval is stale, so an
-- administrator can clear a claim without creating owner authority.
create or replace function public.review_business_claim(
  target_claim_id uuid,
  decision text,
  moderation_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_business_id uuid;
  target_claimant_id uuid;
  target_claim_state text;
  target_business_state public.business_state;
  target_business_provenance text;
  normalized_reason text := btrim(coalesce(moderation_reason, ''));
begin
  perform private.require_aal2();
  if not private.is_platform_staff(
    actor,
    array['admin']::public.platform_role[]
  ) then
    raise exception using errcode = '42501', message = 'Platform administrator role required';
  end if;
  if decision is null
    or decision not in ('approved', 'rejected')
    or char_length(normalized_reason) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'Invalid claim decision';
  end if;

  -- Lock order is business -> claim. The claim's business_id is immutable to
  -- application callers, and the join also makes a deleted business fail as
  -- a not-found claim instead of proceeding with partial authority changes.
  select b.id, b.state, b.provenance
  into target_business_id, target_business_state, target_business_provenance
  from public.business_claims bc
  join public.businesses b on b.id = bc.business_id
  where bc.id = target_claim_id
  for update of b;

  if not found then
    raise exception using errcode = '22023', message = 'Claim not found';
  end if;

  select bc.claimant_id, bc.state
  into target_claimant_id, target_claim_state
  from public.business_claims bc
  where bc.id = target_claim_id
    and bc.business_id = target_business_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Claim not found';
  end if;

  -- A retry after a committed decision is a no-op. This keeps administrator
  -- retries idempotent without duplicating the decision audit event.
  if target_claim_state = decision then
    return;
  end if;
  if target_claim_state <> 'pending' then
    raise exception using errcode = '55000', message = 'CLAIM_ALREADY_DECIDED';
  end if;

  -- Keep the deny path independent of approval eligibility. This preserves
  -- moderation cleanup and its existing audit event even for stale claims.
  if decision = 'rejected' then
    update public.business_claims
    set state = 'rejected',
        reviewed_by = actor,
        reviewed_at = now()
    where id = target_claim_id
      and state = 'pending';

    perform private.write_audit_event(
      actor,
      target_business_id,
      'business.claim_decided',
      'business_claim',
      target_claim_id::text,
      jsonb_build_object('decision', decision, 'reason', normalized_reason)
    );
    return;
  end if;

  -- Lock the claimant profile before checking account state. Account/profile
  -- lifecycle writes therefore cannot deactivate the claimant between this
  -- check and the owner-membership insert.
  perform 1
  from public.profiles p
  join auth.users u on u.id = p.user_id
  where p.user_id = target_claimant_id
  for update of p;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'CLAIMANT_NOT_ACTIVE';
  end if;

  if not private.is_active_user(target_claimant_id) then
    raise exception using
      errcode = '55000',
      message = 'CLAIMANT_NOT_ACTIVE';
  end if;

  -- A claim is only approvable while its listing is still a published,
  -- eligible community/provider record. Owner provenance is deliberately
  -- excluded: it indicates an ownership transition already occurred, even if
  -- historical data has lost the corresponding membership row.
  if target_business_state <> 'published'::public.business_state
    or target_business_provenance not in ('community', 'licensed_provider')
    or not private.is_business_publicly_eligible(target_business_id)
  then
    raise exception using
      errcode = '55000',
      message = 'CLAIM_BUSINESS_NOT_ELIGIBLE';
  end if;

  if exists (
    select 1
    from public.business_members claimant_membership
    where claimant_membership.business_id = target_business_id
      and claimant_membership.user_id = target_claimant_id
      and claimant_membership.status = 'active'
  ) then
    raise exception using
      errcode = '55000',
      message = 'CLAIMANT_ALREADY_BUSINESS_MEMBER';
  end if;

  if exists (
    select 1
    from public.business_members bm
    where bm.business_id = target_business_id
      and bm.role = 'owner'
      and bm.status = 'active'
  ) then
    raise exception using
      errcode = '55000',
      message = 'BUSINESS_ALREADY_CLAIMED';
  end if;

  if exists (
    select 1
    from public.business_claims approved_claim
    where approved_claim.business_id = target_business_id
      and approved_claim.state = 'approved'
  ) then
    raise exception using
      errcode = '55000',
      message = 'BUSINESS_CLAIM_CONFLICT';
  end if;

  update public.business_claims
  set state = decision,
      reviewed_by = actor,
      reviewed_at = now()
  where id = target_claim_id
    and state = 'pending';

  insert into public.business_members (
    business_id,
    user_id,
    role,
    status,
    invited_by,
    accepted_at,
    revoked_at
  )
  values (
    target_business_id,
    target_claimant_id,
    'owner',
    'active',
    actor,
    now(),
    null
  )
  -- A revoked historical membership may be restored only after the verified
  -- administrator approval above. Active memberships are rejected explicitly.
  on conflict (business_id, user_id)
  do update set
    role = 'owner',
    status = 'active',
    accepted_at = now(),
    revoked_at = null;

  update public.businesses
  set provenance = 'owner',
      verification = case
        when verification = 'unverified' then 'pending'::public.verification_state
        else verification
      end
  where id = target_business_id;

  perform private.write_audit_event(
    actor,
    target_business_id,
    'business.claim_decided',
    'business_claim',
    target_claim_id::text,
    jsonb_build_object('decision', decision, 'reason', normalized_reason)
  );
end;
$$;

revoke all on function public.review_business_claim(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_business_claim(uuid, text, text) to authenticated;
