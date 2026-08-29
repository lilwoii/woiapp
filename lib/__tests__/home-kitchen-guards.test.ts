import {
  filterHomeKitchenPlaces,
  featureFlags,
  HOME_KITCHEN_CHAT_UNAVAILABLE_REASON,
  HOME_KITCHEN_UNAVAILABLE_REASON,
  isHomeKitchenBlocked,
  PUBLIC_LISTING_UNAVAILABLE_REASON,
  publicListingRouteUnavailableReason,
} from '@/lib/features';
import {
  getMarketplaceConversationContext,
  isMarketplaceChatAvailable,
  listMarketplaceConversations,
  startMarketplaceConversation,
} from '@/lib/marketplace-chat';

const mockRpc = jest.fn();
const mockCreateAccountBoundSupabaseClient = jest.fn();

jest.mock('@/lib/supabase', () => ({
  createAccountBoundSupabaseClient: (...args: unknown[]) =>
    mockCreateAccountBoundSupabaseClient(...args),
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

const businessId = 'cf844b56-696c-48cf-9f72-715d823776f3';
const conversationId = 'a418d851-2f2a-4ed8-8df8-52a1293c6211';
const accountId = '44df8f4e-9e6d-45f3-bf3f-0a6b4c6e11c5';

describe('disabled home-kitchen client guards', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockCreateAccountBoundSupabaseClient.mockReset();
  });

  it('fails closed for home-kitchen cache entries without hiding managed data from the raw store', () => {
    const places = [
      { id: businessId, category: 'home_kitchen' },
      { id: conversationId, category: 'restaurant' },
    ];

    expect(isHomeKitchenBlocked('home_kitchen')).toBe(!featureFlags.homeKitchens);
    const publicPlaces = filterHomeKitchenPlaces(places);
    if (featureFlags.homeKitchens) {
      expect(publicPlaces).toEqual(places);
    } else {
      expect(publicPlaces).toEqual([places[1]]);
    }
  });

  it('does not start or probe disabled home-kitchen chat when the kind is known', async () => {
    if (featureFlags.homeKitchens) return;

    await expect(startMarketplaceConversation(businessId, accountId, 'home_kitchen'))
      .resolves.toEqual({
        ok: false,
        code: 'NOT_FOUND',
        reason: HOME_KITCHEN_CHAT_UNAVAILABLE_REASON,
      });
    await expect(isMarketplaceChatAvailable(businessId, 'home_kitchen')).resolves.toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCreateAccountBoundSupabaseClient).not.toHaveBeenCalled();
  });

  it('filters disabled home-kitchen inbox rows and rejects disabled context hydration', async () => {
    if (featureFlags.homeKitchens) return;

    mockRpc.mockResolvedValueOnce({
      data: [
        {
          conversation_public_id: conversationId,
          business_id: businessId,
          business_name: 'Private kitchen',
          business_kind: 'home_kitchen',
          conversation_state: 'open',
          counterpart_name: 'Kitchen seller',
          counterpart_username: 'seller',
        },
        {
          conversation_public_id: businessId,
          business_id: conversationId,
          business_name: 'Open pop-up',
          business_kind: 'pop_up',
          conversation_state: 'open',
          counterpart_name: 'Pop-up seller',
          counterpart_username: 'popup',
        },
      ],
      error: null,
    });
    const inbox = await listMarketplaceConversations();
    expect(inbox.ok).toBe(true);
    if (!inbox.ok) throw new Error(inbox.reason);
    expect(inbox.data?.map((entry) => entry.businessCategory)).toEqual(['pop_up']);

    mockRpc.mockResolvedValueOnce({
      data: {
        business_kind: 'home_kitchen',
        participant_role: 'customer',
        actor_public_profile_id: accountId,
        payment_methods: [],
        platform_payment_enabled: false,
      },
      error: null,
    });
    await expect(getMarketplaceConversationContext(conversationId)).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
      reason: HOME_KITCHEN_CHAT_UNAVAILABLE_REASON,
    });
  });

  it('maps the server home-kitchen access denial to a blocked result, but preserves network retryability', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'CHAT_ACCESS_REQUIRED' },
    });
    await expect(getMarketplaceConversationContext(conversationId)).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
      reason: HOME_KITCHEN_CHAT_UNAVAILABLE_REASON,
    });

    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { status: 0, message: 'Network request failed' },
    });
    await expect(getMarketplaceConversationContext(conversationId)).resolves.toMatchObject({
      ok: false,
      code: 'NETWORK',
    });
  });

  it('uses generic route/cache copy rather than exposing a private location', () => {
    expect(HOME_KITCHEN_UNAVAILABLE_REASON).toBe('This listing is unavailable.');
    expect(HOME_KITCHEN_CHAT_UNAVAILABLE_REASON).toBe('This conversation is unavailable.');
  });

  it('allows only published records through public-looking listing routes', () => {
    expect(publicListingRouteUnavailableReason(undefined)).toBeNull();
    expect(publicListingRouteUnavailableReason({
      category: 'restaurant',
      publicationState: 'published',
    })).toBeNull();
    expect(publicListingRouteUnavailableReason({
      category: 'restaurant',
      publicationState: 'draft',
    })).toBe(PUBLIC_LISTING_UNAVAILABLE_REASON);
    expect(publicListingRouteUnavailableReason({
      category: 'restaurant',
    })).toBe(PUBLIC_LISTING_UNAVAILABLE_REASON);
  });

});
