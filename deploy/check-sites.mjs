/**
 * Post-deploy smoke check: verifies that every site on the host still answers
 * the same way it did before a change (run before/after and compare).
 *
 *   node deploy/check-sites.mjs <ip>     # IP of the host the sites are served from
 *
 * HTTP is tested with an explicit Host header and HTTPS with --resolve, so the
 * check works regardless of public DNS and exercises nginx virtual hosting.
 */
import {execFileSync} from 'node:child_process';

const ip = process.argv[2];
if (!ip) {
  console.error('usage: node deploy/check-sites.mjs <ip>');
  process.exit(1);
}

const sites = [
  'test-domain.ru',
  'game-cm.test-domain.ru',
  'game-vs.test-domain.ru',
  'iboobs.test-domain.ru',
  'padel-russia.online',
  'site-agent.online',
  'uki.test-domain.ru',
  'your-virtual-cutie.ru',
  'poly-signals.ru'
];

function curl(args) {
  try {
    return execFileSync('curl', args, {encoding: 'utf8', timeout: 15000}).trim();
  } catch (error) {
    return `ERR ${(error.status ?? '').toString()}`;
  }
}

console.log(`${'site'.padEnd(26)} ${'http'.padEnd(24)} https`);
for (const host of sites) {
  const http = curl([
    '-s', '-o', '/dev/null',
    '-H', `Host: ${host}`,
    '-w', '%{http_code} %{redirect_url}',
    `http://${ip}/`
  ]);
  const https = curl([
    '-s', '-o', '/dev/null',
    '--resolve', `${host}:443:${ip}`,
    '-w', '%{http_code} ssl=%{ssl_verify_result}',
    `https://${host}/`
  ]);
  console.log(`${host.padEnd(26)} ${http.padEnd(24)} ${https}`);
}
