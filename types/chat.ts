import type { BusinessCategory } from '@/types/marketplace';

export type MarketplaceConversation = {
  id: string;
  businessId: string;
  businessName: string;
  businessCategory: BusinessCategory;
  state: 'open' | 'closed_by_customer' | 'closed_by_merchant' | 'restricted';
  counterpart: {
    profileId: string;
    name: string;
    username: string;
    avatarUrl?: string;
  };
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount: number;
  createdAt: string;
};

export type MarketplaceChatAttachment = {
  assetId: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
};

export type MarketplaceChatMessage = {
  id: string;
  sequence: number;
  sender: {
    profileId: string;
    name: string;
    username: string;
    avatarUrl?: string;
  };
  body?: string;
  attachments: MarketplaceChatAttachment[];
  visibility: 'visible' | 'moderated' | 'removed';
  sentAt: string;
  readAt?: string;
};

export type MarketplaceTypingMember = {
  profileId: string;
  name: string;
  username: string;
  avatarUrl?: string;
  expiresAt: string;
};
