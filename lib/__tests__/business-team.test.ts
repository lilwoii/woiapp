import {
  capabilitiesForRole,
  createTeamIdempotencyKey,
  mapBusinessInvitations,
  mapBusinessTeamWorkspace,
  validateInviteTarget,
} from '../business-team';

describe('business team validation and mapping', () => {
  it('normalizes email and username invitation targets', () => {
    expect(validateInviteTarget(' Owner@Example.COM ')).toEqual({
      kind: 'email',
      value: 'owner@example.com',
    });
    expect(validateInviteTarget(' @night-market ')).toEqual({
      kind: 'username',
      value: 'night-market',
    });
  });

  it('rejects incomplete invitation identifiers', () => {
    expect(() => validateInviteTarget('owner@')).toThrow(
      'Enter a complete email address'
    );
    expect(() => validateInviteTarget('@')).toThrow(
      'Username must contain at least 1 character'
    );
  });

  it('maps only public member identity and orders roles predictably', () => {
    const mapped = mapBusinessTeamWorkspace({
      business_id: '74c00da5-6f88-46a7-a28b-704029a7cfa5',
      business_name: 'Night Market Kitchen',
      actor_role: 'owner',
      members: [
        {
          public_id: '53e70e98-ac80-4978-a7d2-4a1284c29f7b',
          user_id: 'private-auth-id-must-not-leak',
          username: 'sam',
          display_name: 'Sam Diaz',
          avatar_path: null,
          role: 'staff',
          accepted_at: '2026-07-20T12:00:00.000Z',
          is_actor: false,
        },
        {
          public_id: 'b606c3ea-06f2-4f23-a423-c373f167fd90',
          user_id: 'another-private-auth-id',
          username: 'maya',
          display_name: 'Maya Rose',
          avatar_path: null,
          role: 'owner',
          accepted_at: '2026-07-10T12:00:00.000Z',
          is_actor: true,
        },
      ],
      invitations: [],
    });

    expect(mapped.viewerRole).toBe('owner');
    expect(mapped.members.map((member) => member.role)).toEqual(['owner', 'staff']);
    expect(mapped.members[0]).toEqual({
      memberPublicId: 'b606c3ea-06f2-4f23-a423-c373f167fd90',
      username: 'maya',
      displayName: 'Maya Rose',
      avatarPath: null,
      role: 'owner',
      joinedAt: '2026-07-10T12:00:00.000Z',
      isCurrentUser: true,
    });
    expect(mapped.members[0]).not.toHaveProperty('userId');
  });

  it('rejects staff snapshots from the administration surface', () => {
    expect(() =>
      mapBusinessTeamWorkspace({
        business_id: '74c00da5-6f88-46a7-a28b-704029a7cfa5',
        business_name: 'Night Market Kitchen',
        actor_role: 'staff',
        members: [],
        invitations: [],
      })
    ).toThrow('Owner or manager access is required');
  });

  it('maps invitation inbox data without requiring authentication identifiers', () => {
    expect(
      mapBusinessInvitations([
        {
          invitation_id: 'b9204a2c-4bf8-4429-ab86-400c5f2ea161',
          business_id: '74c00da5-6f88-46a7-a28b-704029a7cfa5',
          business_name: 'Night Market Kitchen',
          target_hint: '@sam',
          target_type: 'username',
          role: 'manager',
          state: 'pending',
          invited_at: '2026-07-29T12:00:00.000Z',
          expires_at: '2026-08-05T12:00:00.000Z',
          invited_by_display_name: 'Maya Rose',
        },
      ])
    ).toEqual([
      {
        invitationId: 'b9204a2c-4bf8-4429-ab86-400c5f2ea161',
        businessId: '74c00da5-6f88-46a7-a28b-704029a7cfa5',
        businessName: 'Night Market Kitchen',
        targetHint: '@sam',
        targetType: 'username',
        role: 'manager',
        state: 'pending',
        invitedAt: '2026-07-29T12:00:00.000Z',
        expiresAt: '2026-08-05T12:00:00.000Z',
        invitedByDisplayName: 'Maya Rose',
      },
    ]);
  });

  it('keeps ownership-only controls out of manager capabilities', () => {
    expect(capabilitiesForRole('manager')).toMatchObject({
      canInviteManager: false,
      canInviteStaff: true,
      canChangeManagerRoles: false,
      canTransferOwnership: false,
    });
    expect(capabilitiesForRole('owner').canTransferOwnership).toBe(true);
  });

  it('creates bounded, action-scoped idempotency keys', () => {
    const first = createTeamIdempotencyKey('invite');
    const second = createTeamIdempotencyKey('invite');

    expect(first).toMatch(/^spottr-team:invite:/);
    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second).not.toBe(first);
  });
});
