import { payrollConfig } from '../src/payroll/payout-provider';

const secret = 'x'.repeat(32);

describe('payrollConfig (PAYOUT_MODE)', () => {
  it('is off unless asked for', () => {
    expect(payrollConfig({})).toBeNull();
    expect(payrollConfig({ PAYOUT_MODE: '' })).toBeNull();
  });

  it('refuses the sandbox in production, a short secret and unknown modes', () => {
    const env = { PAYOUT_MODE: 'sandbox', PAYOUT_WEBHOOK_SECRET: secret };
    expect(() => payrollConfig({ ...env, NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => payrollConfig({ ...env, PAYOUT_WEBHOOK_SECRET: 'short' })).toThrow(/SECRET/);
    expect(() => payrollConfig({ ...env, PAYOUT_MODE: 'live' })).toThrow(/unknown/);
    expect(payrollConfig(env)?.provider.name).toBe('sandbox');
  });
});
