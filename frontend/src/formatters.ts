const TOKEN_DECIMALS = 18;
const DEFAULT_MAX_FRACTION_DIGITS = 6;

type DateInput = Date | number;

const integerFormatters = new Map<string, Intl.NumberFormat>();
const decimalSeparators = new Map<string, string>();
const digitMaps = new Map<string, readonly string[]>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const updatedTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function getIntegerFormatter(locale: string): Intl.NumberFormat {
  const cached = integerFormatters.get(locale);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  });
  integerFormatters.set(locale, formatter);
  return formatter;
}

function getDecimalSeparator(locale: string): string {
  const cached = decimalSeparators.get(locale);
  if (cached) return cached;

  const separator =
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })
      .formatToParts(1.1)
      .find(({ type }) => type === "decimal")?.value ?? ".";
  decimalSeparators.set(locale, separator);
  return separator;
}

function getDigitMap(locale: string): readonly string[] {
  const cached = digitMaps.get(locale);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: 0,
  });
  const digits = Array.from({ length: 10 }, (_, digit) => formatter.format(digit));
  digitMaps.set(locale, digits);
  return digits;
}

function localizeDigits(value: string, locale: string): string {
  const digits = getDigitMap(locale);
  return Array.from(value, (digit) => digits[digit.charCodeAt(0) - 48]).join("");
}

/**
 * Formats an 18-decimal token amount without converting the full bigint to a
 * floating-point number. The returned value contains no token or currency symbol.
 */
export function formatUsdc(
  value: bigint,
  locale: string,
  maximumFractionDigits = DEFAULT_MAX_FRACTION_DIGITS,
): string {
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0) {
    throw new RangeError("maximumFractionDigits must be a non-negative integer");
  }

  const displayedDecimals = Math.min(maximumFractionDigits, TOKEN_DECIMALS);
  const absoluteValue = value < 0n ? -value : value;
  const reductionFactor = 10n ** BigInt(TOKEN_DECIMALS - displayedDecimals);
  const roundedValue =
    reductionFactor === 1n
      ? absoluteValue
      : (absoluteValue + reductionFactor / 2n) / reductionFactor;
  const displayedScale = 10n ** BigInt(displayedDecimals);
  const integerPart = roundedValue / displayedScale;
  const negative = value < 0n && roundedValue !== 0n;
  const formattedInteger = getIntegerFormatter(locale).format(
    negative ? (integerPart === 0n ? -0 : -integerPart) : integerPart,
  );

  if (displayedDecimals === 0) return formattedInteger;

  const fractionPart = (roundedValue % displayedScale)
    .toString()
    .padStart(displayedDecimals, "0")
    .replace(/0+$/, "");

  if (!fractionPart) return formattedInteger;

  return `${formattedInteger}${getDecimalSeparator(locale)}${localizeDigits(fractionPart, locale)}`;
}

export function formatCount(value: number | bigint, locale: string): string {
  return getIntegerFormatter(locale).format(value);
}

/** Formats a percentage whose input is on a 0–100 scale. */
export function formatPercentage(
  value: number,
  locale: string,
  maximumFractionDigits = 0,
): string {
  const percentage = Math.min(100, Math.max(0, value));
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits,
  }).format(percentage / 100);
}

function getDateTimeFormatter(locale: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatters.get(locale);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  dateTimeFormatters.set(locale, formatter);
  return formatter;
}

function getUpdatedTimeFormatter(locale: string): Intl.DateTimeFormat {
  const cached = updatedTimeFormatters.get(locale);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  updatedTimeFormatters.set(locale, formatter);
  return formatter;
}

export function formatDateTime(value: DateInput, locale: string): string {
  return getDateTimeFormatter(locale).format(value);
}

export function formatEpochSeconds(value: bigint | number, locale: string): string {
  const seconds = typeof value === "bigint" ? Number(value) : value;
  return formatDateTime(seconds * 1_000, locale);
}

export function formatUpdatedTime(value: DateInput, locale: string): string {
  return getUpdatedTimeFormatter(locale).format(value);
}
