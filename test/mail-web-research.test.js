import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailWebResearch, mailPageText } from '../lib/mail-web-research.js';

const email = 'private-localpart@customer.example.org';
const result = (url = 'https://help.example.org/mail', snippet = 'SMTP settings') => ({ url, title: 'Official help', snippet });
const html = '<h1>SMTP configuration</h1><table><tr><td>smtp.mailhost.com</td><td>465</td><td>SSL/TLS</td></tr></table>';
const quote = 'smtp.mailhost.com 465 SSL/TLS';
const make = options => createMailWebResearch({ search: async () => ({ status: 'found', results: [result()] }),
  resolveMx: async () => [{ exchange: 'mx.mailhost.com', priority: 10 }], fetchText: async () => html, ...options });
async function page(research, address = email) {
  const found = await research.search(address);
  assert.equal(found.status, 'found');
  return research.read(address, found.results[0].id);
}
const proposal = page => ({ pageId: page.pageId, host: 'smtp.mailhost.com', port: 465, mode: 'tls', excerpt: quote });

test('real search adapter gets mailbox domain and at most two MX provider domains, never localpart', async () => {
  const queries = [];
  const research = make({
    resolveMx: async domain => {
      assert.equal(domain, 'customer.example.org');
      return [
        { exchange: 'mx.provider.co.uk', priority: 10 }, { exchange: 'mx2.provider.co.uk', priority: 20 },
        { exchange: 'mx.other.com', priority: 30 }, { exchange: 'mx.fourth.com', priority: 40 },
      ];
    },
    search: async domain => { queries.push(domain); return { status: 'found', results: [result(`https://help.${domain}/smtp`)] }; },
  });
  const found = await research.search(email);
  assert.equal(found.results.length, 3);
  assert.deepEqual(queries, ['customer.example.org', 'provider.co.uk', 'other.com']);
  assert.ok(queries.every(value => !value.includes('@') && !value.includes('private-localpart')));
  assert.equal(found.untrustedContent, true);
});

test('official qualification uses registered domains including private suffix tenant boundaries', async () => {
  const research = make({ search: async () => ({ status: 'found', results: [
    result('https://help.company.co.uk/smtp'), result('https://company.co.uk.evil.com/'),
    result('https://unrelated.co.uk/'), result('https://company.co.uk@evil.com/'),
    result('http://company.co.uk/'), result('https://company.co.uk:8443/'),
  ] }) });
  const found = await research.search('a@company.co.uk');
  assert.deepEqual(found.results.map(item => item.url), ['https://help.company.co.uk/smtp']);
  const tenants = make({ search: async () => ({ status: 'found', results: [
    result('https://docs.owner.github.io/mail'), result('https://evil.github.io/mail'),
  ] }) });
  const privateSuffix = await tenants.search('a@owner.github.io');
  assert.deepEqual(privateSuffix.results.map(item => item.url), ['https://docs.owner.github.io/mail']);
});

test('full fetched official page, not search snippet, verifies SMTP settings on the confirmed MX service domain', async () => {
  const research = make({ search: async () => ({ status: 'found', results: [result(undefined, 'smtp.evil.com 465 TLS')] }) });
  const content = await page(research);
  assert.equal(content.untrustedContent, true);
  const checked = research.verify(email, proposal(content));
  assert.deepEqual(checked, { smtp: { host: 'smtp.mailhost.com', port: 465, mode: 'tls' },
    source: { kind: 'official_web', url: 'https://help.example.org/mail' } });
  assert.throws(() => research.verify(email, { ...proposal(content), host: 'smtp.evil.com', excerpt: 'smtp.evil.com 465 TLS' }), { code: 'INVALID_EVIDENCE' });
});

test('HTML parsing removes scripts, styles, forms, hidden elements and comments before evidence is exposed', () => {
  const parsed = mailPageText(`<html><head><title>secret title</title></head><body>
    <script>secret script</script><style>secret style</style><!-- secret comment -->
    <form><div>secret form</div></form><span hidden>secret hidden</span>
    <div style="display: none">secret css</div><p aria-hidden="true">secret aria</p>
    <div><b>SMTP</b> smtp.provider.com &amp; SSL</div><p>465</p></body></html>`);
  assert.doesNotMatch(parsed, /secret/);
  assert.match(parsed, /SMTP/);
  assert.match(parsed, /smtp.provider.com & SSL/);
  assert.match(parsed, /465/);
  assert.equal(mailPageText('<p>' + 'a'.repeat(50000) + '</p>').length, 32768);
  assert.throws(() => mailPageText('x'.repeat(256 * 1024 + 1)), { code: 'INVALID_PAGE' });
});

test('read accepts only this mailbox search IDs and constrains every fetch URL and redirect', async () => {
  const research = make({ fetchText: async (url, options) => {
    assert.equal(url, 'https://help.example.org/mail');
    assert.equal(options.maxBytes, 256 * 1024);
    assert.equal(options.maxRedirects, 2);
    assert.equal(options.validateUrl(new URL('https://docs.example.org/redirect')), true);
    assert.throws(() => options.validateUrl(new URL('https://unrelated.com/redirect')), { code: 'UNOFFICIAL_SOURCE' });
    assert.throws(() => options.validateUrl('http://help.example.org/mail'), { code: 'UNOFFICIAL_SOURCE' });
    return html;
  } });
  const content = await page(research);
  assert.equal(content.url, 'https://help.example.org/mail');
  await assert.rejects(research.read(email, 'https://evil.com/'), { code: 'UNKNOWN_RESULT' });
  await assert.rejects(research.read('another@customer.example.org', content.pageId), { code: 'EVIDENCE_EXPIRED' });
  assert.throws(() => research.verify('another@customer.example.org', proposal(content)), { code: 'EVIDENCE_EXPIRED' });
  const other = make();
  await page(other);
  assert.throws(() => other.verify(email, proposal(content)), { code: 'UNKNOWN_PAGE' });
});

test('evidence rejects wrong host/port/mode, fabricated excerpts, oversized excerpts and suffix lookalikes', async () => {
  const research = make();
  const content = await page(research);
  for (const change of [
    { host: 'mailhost.com' }, { host: 'smtp.mailhost.com.evil.com' }, { port: 46 }, { port: 587 },
    { mode: 'plain' }, { mode: 'starttls' }, { excerpt: 'SMTP host smtp.mailhost.com 465 SSL/TLS' },
    { excerpt: 'a'.repeat(1501) }, { host: '127.0.0.1' }, { host: 'smtp.local' },
  ]) assert.throws(() => research.verify(email, { ...proposal(content), ...change }), { code: 'INVALID_EVIDENCE' });
  const starttls = make({ resolveMx: async () => [{ exchange: 'mx.provider.com', priority: 10 }], fetchText: async () => 'SMTP smtp.provider.com 587 STARTTLS' });
  const startPage = await page(starttls);
  const startProposal = { pageId: startPage.pageId, host: 'smtp.provider.com', port: 587, mode: 'starttls', excerpt: startPage.text };
  assert.equal(starttls.verify(email, startProposal).smtp.mode, 'starttls');
  assert.throws(() => starttls.verify(email, { ...startProposal, mode: 'tls' }), { code: 'INVALID_EVIDENCE' });
});

test('MX is only identity evidence and never returns a guessed SMTP candidate', async () => {
  const research = make({ resolveMx: async () => [{ exchange: 'mx.provider.com', priority: 10 }],
    search: async () => ({ status: 'not_found', results: [] }) });
  const found = await research.search(email);
  assert.equal(found.status, 'not_found');
  assert.equal(found.smtp, undefined);
});

test('missing search service, unavailable search and failed page fetch return safe diagnostics', async () => {
  assert.equal((await createMailWebResearch().search(email)).status, 'unavailable');
  const research = make({ search: async () => { throw new Error('secret internal credential'); } });
  assert.deepEqual(await research.search(email), { status: 'unavailable', domain: 'customer.example.org', results: [], untrustedContent: true });
  const failedPage = make({ fetchText: async () => { throw new Error('secret internal credential'); } });
  const found = await failedPage.search(email);
  await assert.rejects(failedPage.read(email, found.results[0].id), error => error.code === 'PAGE_UNAVAILABLE' && !error.message.includes('secret'));
  const mxFailure = make({ resolveMx: async () => { throw new Error('DNS failed'); } });
  assert.equal((await mxFailure.search(email)).status, 'found');
});

test('evidence expires, repeated search invalidates pages, cache evicts and dispose clears records', async () => {
  let time = 0;
  const research = make({ now: () => time, ttlMs: 10, maxEntries: 1 });
  const old = await page(research);
  time = 11;
  assert.throws(() => research.verify(email, proposal(old)), { code: 'EVIDENCE_EXPIRED' });
  const replaced = await page(research);
  await research.search(email);
  assert.throws(() => research.verify(email, proposal(replaced)), { code: 'UNKNOWN_PAGE' });
  const evicted = await page(research);
  await research.search('other@customer.example.org');
  assert.throws(() => research.verify(email, proposal(evicted)), { code: 'EVIDENCE_EXPIRED' });
  const disposed = await page(research);
  research.dispose();
  assert.throws(() => research.verify(email, proposal(disposed)), { code: 'EVIDENCE_EXPIRED' });
});

test('search results and read pages are bounded and duplicate URLs coalesce', async () => {
  const research = make({ search: async () => ({ status: 'found', results: Array.from({ length: 30 }, (_, i) => result(`https://help.example.org/${i}`)) }) });
  const found = await research.search(email);
  assert.equal(found.results.length, 12);
  const pages = [];
  for (const item of found.results.slice(0, 7)) pages.push(await research.read(email, item.id));
  assert.throws(() => research.verify(email, proposal(pages[0])), { code: 'UNKNOWN_PAGE' });
  assert.equal(research.verify(email, proposal(pages[6])).smtp.port, 465);
  const duplicates = make({ search: async () => ({ status: 'found', results: [result(), result()] }) });
  assert.equal((await duplicates.search(email)).results.length, 1);
});

test('cancellation and hard timeout bound uncooperative adapters without late evidence', async () => {
  const controller = new AbortController();
  controller.abort();
  const stopped = make();
  assert.equal((await stopped.search(email, { signal: controller.signal })).status, 'unavailable');
  const hung = make({ search: async () => new Promise(() => {}), timeoutMs: 10 });
  assert.equal((await hung.search(email)).status, 'unavailable');
  assert.throws(() => hung.verify(email, {}), { code: 'EVIDENCE_EXPIRED' });
  const slowRead = make({ fetchText: async () => new Promise(() => {}), timeoutMs: 10 });
  const found = await slowRead.search(email);
  await assert.rejects(slowRead.read(email, found.results[0].id), { code: 'ABORTED' });
});


test('Microsoft delegated MX permits official Microsoft help, but a suffix lookalike does not', async () => {
  for (const [mx, accepted] of [
    ['customer-org.mail.protection.outlook.com', true], ['customer-org.mx.microsoft', true],
    ['customer-org.mail.protection.outlook.com.evil.com', false], ['eviloutlook.com', false],
  ]) {
    const queries = [];
    const research = make({ resolveMx: async () => [{ exchange: mx, priority: 10 }],
      search: async domain => { queries.push(domain); return { status: 'found', results: [result('https://learn.microsoft.com/en-us/exchange/smtp')] }; } });
    const found = await research.search(email);
    assert.equal(found.status, accepted ? 'found' : 'not_found');
    assert.equal(queries.includes('microsoft.com'), accepted);
  }
});


test('default search permits the official 60-second provider budget while page reads stop at 20 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let step = 0; step < 20; step++) await Promise.resolve(); };
  let started = false;
  let finished = false;
  const research = make({
    search: async () => {
      started = true;
      await new Promise(resolve => setTimeout(resolve, 60000));
      return { status: 'found', results: [result()] };
    },
    fetchText: async () => new Promise(() => {}),
  });
  const searching = research.search(email).then(value => { finished = true; return value; });
  await flush();
  assert.equal(started, true);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(finished, false);
  t.mock.timers.tick(40000);
  const found = await searching;
  assert.equal(found.status, 'found');
  const reading = research.read(email, found.results[0].id);
  const failed = assert.rejects(reading, { code: 'ABORTED' });
  t.mock.timers.tick(20000);
  await failed;
  const hung = make({ search: async () => new Promise(() => {}) });
  const stopped = hung.search(email);
  await flush();
  t.mock.timers.tick(65000);
  assert.equal((await stopped).status, 'unavailable');
});

test('search and read budgets can be shortened independently for cancellation', async () => {
  const research = make({ searchTimeoutMs: 30, readTimeoutMs: 5,
    search: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { status: 'found', results: [result()] };
    },
    fetchText: async () => new Promise(() => {}),
  });
  const found = await research.search(email);
  assert.equal(found.status, 'found');
  await assert.rejects(research.read(email, found.results[0].id), { code: 'ABORTED' });
});


test('provider forum, community and Q&A content cannot supply official SMTP evidence', async () => {
  const blocked = [
    'https://learn.microsoft.com/en-us/answers/questions/12345/smtp-settings',
    'https://learn.microsoft.com/en-us/%61nswers/questions/12345/smtp-settings',
    'https://answers.microsoft.com/smtp-settings',
    'https://community.microsoft.com/smtp-settings',
    'https://forum.microsoft.com/smtp-settings',
    'https://forums.microsoft.com/smtp-settings',
    'https://learn.microsoft.com/community/smtp',
    'https://learn.microsoft.com/forum/smtp',
    'https://learn.microsoft.com/forums/smtp',
    'https://learn.microsoft.com/questions/smtp',
  ];
  const research = make({ resolveMx: async () => [{ exchange: 'company-com.mail.protection.outlook.com', priority: 10 }],
    search: async () => ({ status: 'found', results: blocked.map(url => result(url)) }),
    fetchText: async () => { assert.fail('user-authored pages must not be read'); },
  });
  assert.equal((await research.search(email)).status, 'not_found');
  const redirect = make({ fetchText: async (url, { validateUrl }) => {
    validateUrl('https://community.example.org/thread');
    return html;
  } });
  const found = await redirect.search(email);
  await assert.rejects(redirect.read(email, found.results[0].id), { code: 'UNOFFICIAL_SOURCE' });
});

test('official page text cannot authorize arbitrary cross-domain SMTP or an MX suffix lookalike', async () => {
  for (const host of ['smtp.attacker.com', 'smtp.mailhost.com.attacker.com', 'smtp.mailhostevil.com']) {
    const text = `SMTP ${host} 465 SSL/TLS`;
    const research = make({ fetchText: async () => text });
    const content = await page(research);
    assert.throws(() => research.verify(email, { ...proposal(content), host, excerpt: text }), { code: 'INVALID_EVIDENCE' });
  }
});

test('Microsoft official documentation can select office365 SMTP only after confirmed Microsoft MX delegation', async () => {
  const sourceUrl = 'https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365';
  const text = 'SMTP smtp.office365.com 587 STARTTLS';
  const research = make({ resolveMx: async () => [{ exchange: 'company-com.mail.protection.outlook.com', priority: 10 }],
    search: async () => ({ status: 'found', results: [result(sourceUrl)] }), fetchText: async () => text });
  const content = await page(research);
  const settings = { pageId: content.pageId, host: 'smtp.office365.com', port: 587, mode: 'starttls', excerpt: text };
  assert.deepEqual(research.verify(email, settings), {
    smtp: { host: 'smtp.office365.com', port: 587, mode: 'starttls' }, source: { kind: 'official_web', url: sourceUrl },
  });
  const unrelated = make({ fetchText: async () => text });
  const otherPage = await page(unrelated);
  assert.throws(() => unrelated.verify(email, { ...settings, pageId: otherPage.pageId }), { code: 'INVALID_EVIDENCE' });
});
