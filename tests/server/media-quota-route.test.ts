import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/personal-modality-quota', () => {
  class PersonalMediaQuotaExceededError extends Error {
    code = 'PERSONAL_MEDIA_MONTHLY_QUOTA_EXCEEDED';
  }
  return {
    PersonalMediaQuotaExceededError,
    reservePersonalMediaQuota: vi.fn(),
    settlePersonalMediaQuota: vi.fn(),
  };
});

import {
  PersonalMediaQuotaExceededError,
  reservePersonalMediaQuota,
  settlePersonalMediaQuota,
} from '@/lib/server/personal-modality-quota';
import { beginMediaQuota, settleMediaQuota } from '@/lib/server/media-quota-route';

const reserve = vi.mocked(reservePersonalMediaQuota);
const settle = vi.mocked(settlePersonalMediaQuota);

beforeEach(() => {
  reserve.mockReset();
  settle.mockReset();
});

describe('beginMediaQuota', () => {
  it('skips personal quota for legacy anonymous owners without reserving', async () => {
    const gate = await beginMediaQuota('anon:legacy', 'image', 1);
    expect(gate).toEqual({ kind: 'skip' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('reserves for an authenticated user principal', async () => {
    reserve.mockResolvedValue({ id: 'res-1' } as never);
    const gate = await beginMediaQuota('user:alice', 'image', 1);
    expect(gate).toEqual({ kind: 'reserved', reservationId: 'res-1', reservedAmount: 1 });
    expect(reserve).toHaveBeenCalledWith('user:alice', 'image', 1);
  });

  it('maps a quota-exceeded reservation to the exceeded gate', async () => {
    reserve.mockRejectedValue(new PersonalMediaQuotaExceededError('image' as never));
    const gate = await beginMediaQuota('user:alice', 'video', 10);
    expect(gate).toEqual({ kind: 'exceeded' });
  });

  it('fails closed on any other reservation error (policy/db unavailable)', async () => {
    reserve.mockRejectedValue(new Error('PERSONAL_MEDIA_QUOTA_DATABASE_UNAVAILABLE'));
    const gate = await beginMediaQuota('user:alice', 'tts', 5);
    expect(gate.kind).toBe('unavailable');
  });
});

describe('settleMediaQuota', () => {
  it('does nothing for skipped or non-reserved gates', async () => {
    await settleMediaQuota({ kind: 'skip' }, 1);
    await settleMediaQuota({ kind: 'exceeded' }, 1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles the reported actual amount on success', async () => {
    settle.mockResolvedValue(undefined);
    await settleMediaQuota({ kind: 'reserved', reservationId: 'r', reservedAmount: 10 }, 4);
    expect(settle).toHaveBeenCalledWith('r', 4);
  });

  it('charges the full reservation when the provider call failed (null actual)', async () => {
    settle.mockResolvedValue(undefined);
    await settleMediaQuota({ kind: 'reserved', reservationId: 'r', reservedAmount: 10 }, null);
    expect(settle).toHaveBeenCalledWith('r', 10);
  });

  it('falls back to the reservation for an invalid actual amount', async () => {
    settle.mockResolvedValue(undefined);
    await settleMediaQuota({ kind: 'reserved', reservationId: 'r', reservedAmount: 10 }, 1.5);
    expect(settle).toHaveBeenCalledWith('r', 10);
  });

  it('swallows accounting errors so a completed generation is not turned into a 5xx', async () => {
    settle.mockRejectedValue(new Error('boom'));
    await expect(
      settleMediaQuota({ kind: 'reserved', reservationId: 'r', reservedAmount: 3 }, 3),
    ).resolves.toBeUndefined();
  });
});
