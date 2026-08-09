import type { Page, Route } from '@playwright/test';

export const fixtureOrigin = 'https://spottr-fixture.supabase.co';
export const fixtureAppOrigin = 'http://127.0.0.1:4174';
export const fixtureAnonKey = 'spottr-public-fixture-anon-key';

const ids = {
  business: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  customer: '33333333-3333-4333-8333-333333333333',
  conversation: '44444444-4444-4444-8444-444444444444',
  counterpart: '55555555-5555-4555-8555-555555555555',
  factor: '66666666-6666-4666-8666-666666666666',
  update: '77777777-7777-4777-8777-777777777777',
  review: '88888888-8888-4888-8888-888888888888',
  section: '99999999-9999-4999-8999-999999999999',
  item: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const now = '2026-08-09T12:00:00.000Z';
const future = '2099-08-09T12:00:00.000Z';

function base64Url(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function accessToken(role: 'customer' | 'business') {
  return [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({
      aal: role === 'business' ? 'aal2' : 'aal1',
      amr: [{ method: role === 'business' ? 'totp' : 'password', timestamp: 1_786_276_800 }],
      aud: 'authenticated',
      exp: 4_102_444_800,
      iat: 1_786_276_800,
      role: 'authenticated',
      sub: ids.customer,
      spottr_fixture_role: role,
    }),
    base64Url('fixture-signature'),
  ].join('.');
}

function fixtureUser(role: 'customer' | 'business') {
  const businessAccount = role === 'business';
  return {
    id: ids.customer,
    aud: 'authenticated',
    role: 'authenticated',
    email: businessAccount ? 'owner@spottr.test' : 'customer@spottr.test',
    email_confirmed_at: now,
    phone: '',
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {
      display_name: businessAccount ? 'Maya Rivera' : 'Jordan Lee',
      username: businessAccount ? 'maya.owner' : 'jordan.finds',
    },
    identities: [],
    factors: businessAccount
      ? [{
          id: ids.factor,
          friendly_name: 'Spottr authenticator',
          factor_type: 'totp',
          status: 'verified',
          created_at: now,
          updated_at: now,
        }]
      : [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
}

function session(role: 'customer' | 'business') {
  return {
    access_token: accessToken(role),
    token_type: 'bearer',
    expires_in: 2_324_816_000,
    expires_at: 4_102_444_800,
    refresh_token: `fixture-refresh-${role}`,
    user: fixtureUser(role),
  };
}

const business = {
  id: ids.business,
  business_id: ids.business,
  slug: 'maya-taco-truck',
  name: 'Maya Taco Truck',
  kind: 'food_truck',
  description: 'Birria, grilled vegetables, and aguas frescas made for the neighborhood.',
  cuisine_labels: ['Mexican', 'Street food'],
  price_level: 2,
  state: 'published',
  verification: 'verified',
  timezone: 'America/Los_Angeles',
  provenance: 'owner',
  provider_freshness_at: now,
  updated_at: now,
  effective_status: 'open',
  today_is_closed: false,
  today_opens_at: '11:00:00',
  today_closes_at: '20:00:00',
  logo_path: null,
};

const location = {
  id: ids.location,
  location_id: ids.location,
  business_id: ids.business,
  label: 'Arts District lunch stop',
  address_line: '700 S Santa Fe Ave',
  city: 'Los Angeles',
  region: 'CA',
  postal_code: '90021',
  latitude: 34.0355,
  longitude: -118.2324,
  point: { type: 'Point', coordinates: [-118.2324, 34.0355] },
  is_primary: true,
  is_approximate: false,
  public_address: true,
  publication_state: 'published',
  updated_at: now,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-profile, content-type, prefer, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Content-Range': Array.isArray(body) ? `0-${Math.max(0, body.length - 1)}/${body.length}` : '0-0/1',
    },
    body: JSON.stringify(body),
  });
}

function roleFromRequest(route: Route): 'anonymous' | 'customer' | 'business' {
  const authorization = route.request().headers().authorization ?? '';
  if (authorization === `Bearer ${accessToken('business')}`) return 'business';
  if (authorization === `Bearer ${accessToken('customer')}`) return 'customer';
  return 'anonymous';
}

function tableRows(table: string, role: 'anonymous' | 'customer' | 'business') {
  switch (table) {
    case 'profiles':
      return [{
        username: role === 'business' ? 'maya.owner' : 'jordan.finds',
        display_name: role === 'business' ? 'Maya Rivera' : 'Jordan Lee',
        avatar_path: null,
      }];
    case 'follows':
      return role === 'anonymous' ? [] : [{ business_id: ids.business }];
    case 'business_members':
      return role === 'business'
        ? [{ business_id: ids.business, role: 'owner', status: 'active' }]
        : [];
    case 'businesses':
      return role === 'business' ? [{ ...business }] : [];
    case 'public_business_directory':
      return [{ ...business }];
    case 'public_business_locations':
    case 'business_locations':
      return [{ ...location }];
    case 'public_business_updates':
      return [{
        id: ids.update,
        update_id: ids.update,
        business_id: ids.business,
        kind: 'availability',
        body: 'Birria is serving until 8 tonight.',
        created_at: now,
        expires_at: future,
      }];
    case 'public_business_live_status':
      return [{ business_id: ids.business, status: 'open', confirmed_at: now, expires_at: future }];
    case 'public_business_review_aggregates':
      return [{
        business_id: ids.business,
        average_rating: 4.9,
        review_count: 128,
        recent_review_count_7d: 12,
        recent_review_count_30d: 38,
        follower_count: 842,
      }];
    case 'public_business_contacts':
      return [{ business_id: ids.business, phone: '+12135550199', website_url: 'https://example.test' }];
    case 'weekly_hours':
      return Array.from({ length: 7 }, (_, weekday) => ({
        business_id: ids.business,
        weekday,
        opens_at: '11:00:00',
        closes_at: '20:00:00',
        is_closed: false,
      }));
    case 'business_payments':
      return [
        { business_id: ids.business, payment: 'cash' },
        { business_id: ids.business, payment: 'apple_pay' },
      ];
    case 'menu_sections':
      return [{ id: ids.section, business_id: ids.business, name: 'Tacos', sort_order: 0, is_published: true }];
    case 'menu_items':
      return [{
        id: ids.item,
        section_id: ids.section,
        name: 'Birria taco',
        description: 'Slow-braised beef, onion, cilantro',
        price_minor: 450,
        dietary_tags: [],
        availability: 'available',
        sort_order: 0,
        is_published: true,
      }];
    case 'public_reviews':
      return [{
        id: ids.review,
        review_id: ids.review,
        business_id: ids.business,
        author_public_id: ids.counterpart,
        author_username: 'taco.scout',
        author_display_name: 'Avery Chen',
        rating: 5,
        body: 'Fast service and excellent birria.',
        created_at: now,
        helpful_count: 14,
      }];
    case 'mobile_stops':
    case 'special_hours':
    case 'public_business_media':
    case 'public_business_responses':
    case 'public_review_media':
    case 'business_responses':
      return [];
    default:
      return null;
  }
}

function objectResponseRequested(route: Route) {
  return (route.request().headers().accept ?? '').includes('application/vnd.pgrst.object+json');
}

function postBody(route: Route): Record<string, unknown> {
  const value = route.request().postDataJSON();
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactFilter(url: URL, key: string, ...expected: string[]) {
  return expected.includes(url.searchParams.get(key) ?? '');
}

function protectedTableAllowed(
  table: string,
  role: 'anonymous' | 'customer' | 'business',
  url: URL,
) {
  if (table === 'profiles' || table === 'follows' || table === 'business_members') {
    if (role === 'anonymous' || !exactFilter(url, 'user_id', `eq.${ids.customer}`)) return false;
    return table !== 'business_members' || url.searchParams.get('status') === 'eq.active';
  }
  if (
    table === 'businesses' || table === 'business_locations' ||
    table === 'weekly_hours' || table === 'business_payments' ||
    table === 'menu_sections' || table === 'menu_items' ||
    table === 'special_hours' || table === 'business_responses'
  ) {
    if (role !== 'business') return false;
    if (table === 'menu_items') {
      return exactFilter(url, 'section_id', `in.(${ids.section})`);
    }
    const key = table === 'businesses' ? 'id' : 'business_id';
    return exactFilter(url, key, `eq.${ids.business}`, `in.(${ids.business})`);
  }
  if (table === 'public_business_responses' || table === 'public_review_media') {
    return exactFilter(url, 'review_id', `in.(${ids.review})`);
  }
  if (
    table === 'public_business_directory' || table === 'public_business_locations' ||
    table === 'mobile_stops' || table === 'public_business_updates' ||
    table === 'public_business_live_status' || table === 'public_business_review_aggregates' ||
    table === 'public_business_contacts' || table === 'public_reviews' ||
    table === 'public_business_media'
  ) {
    return exactFilter(url, 'business_id', `eq.${ids.business}`, `in.(${ids.business})`);
  }
  return false;
}

export async function installSpottrFixture(page: Page) {
  const unexpected: string[] = [];
  const calls: string[] = [];
  const mapRequests: Record<string, unknown>[] = [];
  const realtimeMessages: string[] = [];
  let realtimeConnections = 0;

  await page.routeWebSocket('wss://spottr-fixture.supabase.co/**', (socket) => {
    realtimeConnections += 1;
    socket.onMessage((message) => {
      if (typeof message !== 'string') {
        unexpected.push('Realtime sent a binary message');
        return;
      }
      realtimeMessages.push(message);
      try {
        const value = JSON.parse(message) as unknown;
        if (Array.isArray(value) && value.length >= 5) {
          const [joinRef, ref, topic, event] = value;
          if (event === 'phx_join') {
            socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {
              status: 'ok', response: { postgres_changes: [] },
            }]));
            return;
          }
          if (event === 'heartbeat' || event === 'phx_leave') {
            socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {
              status: 'ok', response: {},
            }]));
            return;
          }
          if (event === 'access_token') {
            const payload = value[4] as { access_token?: unknown } | undefined;
            const token = payload?.access_token;
            if (token !== accessToken('customer') && token !== accessToken('business')) {
              unexpected.push('Realtime access_token event carried an unexpected user token');
            }
            return;
          }
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (
            record.event === 'phx_join' || record.event === 'heartbeat' ||
            record.event === 'phx_leave'
          ) {
            socket.send(JSON.stringify({
              event: 'phx_reply',
              join_ref: record.join_ref ?? null,
              payload: {
                status: 'ok',
                response: record.event === 'phx_join' ? { postgres_changes: [] } : {},
              },
              ref: record.ref ?? null,
              topic: record.topic,
            }));
            return;
          }
          if (record.event === 'access_token') {
            const payload = record.payload as { access_token?: unknown } | undefined;
            const token = payload?.access_token;
            if (token !== accessToken('customer') && token !== accessToken('business')) {
              unexpected.push('Realtime access_token event carried an unexpected user token');
            }
            return;
          }
        }
        unexpected.push(`Unexpected Realtime message: ${message}`);
      } catch {
        unexpected.push(`Malformed Realtime message: ${message}`);
      }
    });
  });

  await page.route(`${fixtureOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const label = `${method} ${url.pathname}${url.search}`;
    calls.push(label);

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'authorization, apikey, content-profile, content-type, prefer, x-client-info',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        },
      });
      return;
    }

    if (url.pathname === '/map/style.json') {
      await json(route, { version: 8, sources: {}, layers: [] });
      return;
    }

    if (request.headers().apikey !== fixtureAnonKey) {
      unexpected.push(`${label} missing the synthetic anon apikey`);
      await json(route, { message: 'Fixture apikey required' }, 401);
      return;
    }

    if (url.pathname === '/auth/v1/token' && method === 'POST') {
      const body = postBody(route);
      const validGrant = url.searchParams.get('grant_type') === 'password';
      const validPassword = body.password === 'Fixture-password-123!';
      const role = body.email === 'owner@spottr.test'
        ? 'business'
        : body.email === 'customer@spottr.test'
          ? 'customer'
          : null;
      if (!validGrant || !validPassword || !role) {
        unexpected.push(`${label} carried invalid fixture credentials or grant type`);
        await json(route, { message: 'Invalid fixture credentials' }, 400);
        return;
      }
      await json(route, session(role));
      return;
    }

    if (url.pathname === '/auth/v1/user' && method === 'GET') {
      const role = roleFromRequest(route);
      if (role === 'anonymous') {
        unexpected.push(`${label} did not carry a signed-in bearer token`);
        await json(route, { message: 'Signed-in fixture token required' }, 401);
        return;
      }
      await json(route, fixtureUser(role));
      return;
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc = url.pathname.slice('/rest/v1/rpc/'.length);
      const role = roleFromRequest(route);
      const body = postBody(route);
      if (
        rpc === 'search_businesses' && method === 'POST' &&
        body.search_text === 'Los Angeles, CA' && body.result_limit === 100 &&
        body.result_offset === 0
      ) {
        await json(route, [{ business_id: ids.business, has_more: false }]);
        return;
      }
      if (
        rpc === 'map_food_places' && method === 'POST' &&
        body.max_features === 1_200 && body.requested_kinds === null &&
        typeof body.west_longitude === 'number' && typeof body.east_longitude === 'number' &&
        typeof body.south_latitude === 'number' && typeof body.north_latitude === 'number' &&
        typeof body.map_zoom === 'number'
      ) {
        mapRequests.push(body);
        const features = Array.from({ length: 1_200 }, (_, index) => ({
          feature_type: 'place',
          feature_id: `fixture-place-${index}`,
          place_count: 1,
          latitude: 34.0355 + (index % 20) * 0.00001,
          longitude: -118.2324 + Math.floor(index / 20) * 0.00001,
          category_counts: { food_truck: 1 },
          dominant_kind: 'food_truck',
          business_id: index === 0 ? ids.business : null,
          location_id: index === 0 ? ids.location : null,
          business_name: index === 0 ? 'Maya Taco Truck' : `Fixture food truck ${index + 1}`,
          logo_path: null,
          source_label: 'Owner verified',
        }));
        await json(route, features);
        return;
      }
      if (
        rpc === 'is_business_member' && method === 'POST' && role === 'business' &&
        body.target_business_id === ids.business &&
        Array.isArray(body.allowed_roles) && body.allowed_roles.join(',') === 'owner,manager'
      ) {
        await json(route, role === 'business');
        return;
      }
      if (
        rpc === 'list_my_marketplace_conversations_v2' && method === 'POST' &&
        role !== 'anonymous' && body.cursor_time === null &&
        body.cursor_public_id === null && body.result_limit === 50
      ) {
        await json(route, [{
          conversation_public_id: ids.conversation,
          business_id: ids.business,
          business_name: 'Maya Taco Truck',
          business_kind: 'food_truck',
          conversation_state: 'open',
          counterpart_public_profile_id: ids.counterpart,
          counterpart_name: 'Avery Chen',
          counterpart_username: 'taco.scout',
          counterpart_avatar_path: null,
          last_message_preview: 'See you at the Arts District stop.',
          last_message_at: now,
          unread_count: 2,
          created_at: now,
        }]);
        return;
      }
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      const role = roleFromRequest(route);
      const rows = tableRows(table, role);
      if (
        rows !== null && method === 'GET' && url.searchParams.has('select') &&
        protectedTableAllowed(table, role, url)
      ) {
        if (role !== 'anonymous' && request.headers().authorization !== `Bearer ${accessToken(role)}`) {
          unexpected.push(`${label} carried an unexpected bearer token`);
        }
        await json(route, objectResponseRequested(route) ? (rows[0] ?? null) : rows);
        return;
      }
    }

    unexpected.push(label);
    await json(route, { message: `Unexpected fixture request: ${label}` }, 501);
  });

  return {
    calls,
    ids,
    mapRequests,
    realtimeMessages,
    get realtimeConnections() { return realtimeConnections; },
    unexpected,
  };
}

export async function signInThroughUi(page: Page, role: 'customer' | 'business') {
  await page.goto(`${fixtureAppOrigin}/auth`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(role === 'business' ? 'owner@spottr.test' : 'customer@spottr.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('Fixture-password-123!');
  await page.getByRole('button', { name: /^Sign in/u }).click();
  await page.waitForURL(`${fixtureAppOrigin}/`);
}
