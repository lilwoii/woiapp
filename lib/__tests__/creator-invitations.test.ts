import { mapCreatorInvitation } from '../creator-invitations';

const invitation = {
  public_id: '2ddcb10d-3a09-4af3-92f8-0f685f22caf8',
  business_id: '5e6cd592-3d0b-4a3e-a683-d3eeef41a42d',
  business_name: 'Night Market Kitchen',
  sender_public_id: '26b5189d-0067-4a15-b12f-8cd610fb58dd',
  sender_name: 'Avery',
  recipient_public_id: 'fb5699f1-b40a-4672-a41d-aa65581aa55a',
  recipient_name: 'Jordan',
  title: 'Community tasting invitation',
  message: 'Join us for an optional menu tasting. No review is expected or required.',
  response_note: null,
  event_starts_at: '2026-10-01T18:00:00.000Z',
  event_ends_at: '2026-10-01T20:00:00.000Z',
  status: 'pending',
  created_at: '2026-09-15T12:00:00.000Z',
  responded_at: null,
  is_recipient: true,
};

describe('creator invitation contracts', () => {
  it('maps only the participant-safe invitation projection', () => {
    const mapped = mapCreatorInvitation({ ...invitation, sender_id: 'private-auth-id' });

    expect(mapped).toMatchObject({
      id: invitation.public_id,
      businessId: invitation.business_id,
      status: 'pending',
      isRecipient: true,
    });
    expect(mapped).not.toHaveProperty('senderId');
  });

  it('fails closed on malformed dates, participant flags, and content', () => {
    expect(() => mapCreatorInvitation({ ...invitation, event_ends_at: invitation.event_starts_at })).toThrow('date');
    expect(() => mapCreatorInvitation({ ...invitation, is_recipient: 'true' })).toThrow('participant');
    expect(() => mapCreatorInvitation({ ...invitation, title: 'x' })).toThrow('content');
  });
});
