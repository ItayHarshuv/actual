export function calculateCurrencyRevaluation({
  nativeBalance,
  carryingBalance,
  exchangeRate,
}: {
  nativeBalance: number;
  carryingBalance: number;
  exchangeRate: number;
}) {
  return Math.round(nativeBalance * exchangeRate) - carryingBalance;
}
