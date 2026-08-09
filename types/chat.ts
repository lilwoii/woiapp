import type { BusinessCategory } from "@/types/marketplace";

export type MarketplaceConversation = {
  id: string;
  businessId: string;
  businessName: string;
  businessCategory: BusinessCategory;
  state: "open" | "closed_by_customer" | "closed_by_merchant" | "restricted";
  counterpart: {
    profileId?: string;
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
    profileId?: string;
    name: string;
    username: string;
    avatarUrl?: string;
  };
  body?: string;
  attachments: MarketplaceChatAttachment[];
  visibility: "visible" | "held" | "removed";
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

export type MarketplacePickupRequest = {
  id: string;
  startsAt: string;
  endsAt: string;
  note?: string;
  state: "pending" | "authorized" | "declined" | "cancelled" | "expired";
  version: number;
  createdAt: string;
  choice?: {
    id: string;
    kind: "safe_meeting_place" | "seller_residence";
    label: string;
    city: string;
    region: string;
  };
};

export type MarketplacePickupOption = {
  id: string;
  label: string;
  city: string;
  region: string;
  kind:
    | "public_meeting_place"
    | "commercial_site"
    | "safe_meeting_place"
    | "seller_residence";
  address?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  warningRequired?: boolean;
};

export type MarketplacePickupDetail = {
  requestId: string;
  siteId: string;
  label: string;
  kind:
    | "public_meeting_place"
    | "commercial_site"
    | "safe_meeting_place"
    | "seller_residence";
  address: string;
  city: string;
  region: string;
  postalCode?: string;
  latitude: number;
  longitude: number;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
};

export type MarketplaceConversationContext = {
  businessCategory: BusinessCategory;
  role: "customer" | "merchant";
  actorProfileId?: string;
  paymentMethods: string[];
  paymentMethodsConfirmedAt?: string;
  platformPaymentEnabled: false;
};
