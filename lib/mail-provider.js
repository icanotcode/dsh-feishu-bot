import wellKnown from 'nodemailer/lib/well-known';

// Exact domains only: never derive a credential destination from an arbitrary
// email domain, MX record, or lookalike suffix. Transport settings come from the
// installed Nodemailer service catalogue; custom providers remain configurable.
const PROVIDERS = new Map([
  ['qq.com', 'QQ'], ['foxmail.com', 'QQ'],
  ['163.com', '163'], ['126.com', '126'],
  ['gmail.com', 'Gmail'], ['googlemail.com', 'Gmail'],
  ['icloud.com', 'iCloud'], ['me.com', 'iCloud'], ['mac.com', 'iCloud'],
  ['yahoo.com', 'Yahoo'], ['aol.com', 'AOL'],
  ['fastmail.com', 'FastMail'], ['fastmail.fm', 'FastMail'],
  ['aliyun.com', 'Aliyun'], ['gmx.com', 'GMX'], ['gmx.net', 'GMX'], ['gmx.de', 'GMX'],
]);

export function detectMailProvider(address) {
  if (typeof address !== 'string' || address.length > 254 || /[\s\p{Cc}]/u.test(address)) return undefined;
  const parts = address.split('@');
  if (parts.length !== 2 || !parts[0]) return undefined;
  const provider = PROVIDERS.get(parts[1].toLowerCase());
  if (!provider) return undefined;
  const service = wellKnown(provider);
  if (!service?.host || !service.port) return undefined;
  return { host: service.host, port: Number(service.port), mode: service.secure ? 'tls' : 'starttls' };
}
