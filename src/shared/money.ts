/**
 * Money rendering shared by the pricing page and the payment dialog.
 *
 * Both sides must format from the same currency: the server prices an intent
 * from `DIRECT_QR_CURRENCY`, so a hard-coded "$" next to a euro charge would be
 * a mismatch the customer only discovers on the receipt.
 */
export function formatMoney(
  locale: string,
  amount: number,
  currency: string,
  options: { trimZeroFraction?: boolean } = {},
) {
  const code = currency.trim().toUpperCase();
  const trim = options.trimZeroFraction === true && Number.isInteger(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      ...(trim ? { maximumFractionDigits: 0 } : {}),
    }).format(amount);
  } catch {
    // A currency `Intl` rejects must not throw inside a page or a dialog that
    // is mid-payment, so fall back to the plain number plus the code.
    return `${new Intl.NumberFormat(locale).format(amount)} ${code}`;
  }
}
