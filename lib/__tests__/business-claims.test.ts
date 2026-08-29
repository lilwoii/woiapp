import { parseBusinessClaimReceipt } from '@/lib/marketplace-api';

const claimId = '74c00da5-6f88-46a7-a28b-704029a7cfa5';

describe('business claim receipt projection', () => {
  it('requires exactly one explicit-state receipt row', () => {
    expect(parseBusinessClaimReceipt([{ claim_id: claimId, state: 'pending' }])).toEqual({
      claimId,
      state: 'pending',
    });
    expect(parseBusinessClaimReceipt(claimId)).toBeNull();
    expect(parseBusinessClaimReceipt({ claim_id: claimId })).toBeNull();
    expect(parseBusinessClaimReceipt([])).toBeNull();
    expect(parseBusinessClaimReceipt([
      { claim_id: claimId, state: 'pending' },
      { claim_id: claimId, state: 'withdrawn' },
    ])).toBeNull();
  });

  it('preserves server-returned status without exposing private fields', () => {
    const receipt = parseBusinessClaimReceipt({
      claim_id: claimId,
      state: 'rejected',
      evidence_private_path: 'never-client-readable',
      reviewed_by: 'private-reviewer-id',
    });

    expect(receipt).toEqual({ claimId, state: 'rejected' });
    expect(receipt).not.toHaveProperty('evidence_private_path');
    expect(receipt).not.toHaveProperty('reviewed_by');
  });

  it('rejects malformed identifiers and unknown states instead of guessing', () => {
    expect(parseBusinessClaimReceipt({ claim_id: 'not-a-uuid', state: 'pending' })).toBeNull();
    expect(parseBusinessClaimReceipt({ claim_id: claimId, state: 'in_review' })).toBeNull();
  });
});
