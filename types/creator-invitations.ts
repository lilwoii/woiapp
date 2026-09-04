export type CreatorInvitationStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';

export type CreatorInvitation = {
  id: string;
  businessId: string;
  businessName: string;
  senderPublicId: string | null;
  senderName: string;
  recipientPublicId: string;
  recipientName: string;
  title: string;
  message: string;
  responseNote: string | null;
  startsAt: string;
  endsAt: string;
  status: CreatorInvitationStatus;
  createdAt: string;
  respondedAt: string | null;
  isRecipient: boolean;
};
