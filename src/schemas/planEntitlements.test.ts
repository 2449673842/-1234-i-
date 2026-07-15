import { describe, expect, it } from 'vitest';
import { resolvePlanEntitlements } from './planEntitlements';

describe('plan entitlement policy', () => {
  it('keeps anonymous visitors outside authenticated product capabilities', () => {
    const entitlements = resolvePlanEntitlements({ authenticated: false, isPro: false });
    expect(entitlements.plan).toBe('anonymous');
    expect(Object.values(entitlements.capabilities).every(value => value === false)).toBe(true);
  });

  it('preserves existing Free and Pro behavior until commercial tiers are confirmed', () => {
    const free = resolvePlanEntitlements({ authenticated: true, isPro: false });
    const pro = resolvePlanEntitlements({ authenticated: true, isPro: true });
    expect(free.plan).toBe('free');
    expect(pro.plan).toBe('pro');
    expect(free.enforcementMode).toBe('observe');
    expect(pro.enforcementMode).toBe('observe');
    expect(free.capabilities).toEqual(pro.capabilities);
    expect(free.limits).toEqual(pro.limits);
    expect(free.pendingCommercialReview).toBe(true);
  });
});
