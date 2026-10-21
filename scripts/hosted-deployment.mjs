import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  parseInstallArgs,
  serviceUnit,
} from './hosted-backend/install-backend.mjs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  chmod,
} from 'node:fs/promises';

export function validateIceServers(servers) {
  if (
    !Array.isArray(servers) ||
    servers.length > 16 ||
    servers.some(
      (entry) =>
        !entry ||
        !entry.urls ||
        (Array.isArray(entry.urls) && !entry.urls.length) ||
        (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some(
          (url) =>
            typeof url !== 'string' || !/^(stun|stuns|turn|turns):/.test(url)
        )
    )
  )
    throw new Error(
      'ICE configuration must be a JSON array of RTCIceServer entries'
    );
  return servers;
}

export function proxyLocation(config) {
  return `  location = ${new URL(config.daemonUrl).pathname} {
    proxy_pass http://127.0.0.1:${config.daemonPort}/realtime;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host 127.0.0.1:${config.daemonPort};
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    proxy_buffering off;
    access_log off; # One-use transport tickets must not enter access logs.
  }
`;
}

function serverStart(hostname) {
  return `# Install inside nginx's http context after obtaining the certificate.
server {
  listen 443 ssl;
  server_name ${hostname};
  ssl_certificate /etc/letsencrypt/live/${hostname}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${hostname}/privkey.pem;
`;
}

export function nginxBackend(config) {
  return (
    serverStart(new URL(config.daemonUrl).hostname) +
    proxyLocation(config) +
    '  location / { return 404; }\n}\n'
  );
}

export function nginxFrontend(config) {
  return (
    serverStart(config.hostname) +
    `  root /srv/qortal-hub/www;
  index index.html;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy credentialless always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
${new URL(config.daemonUrl).hostname === config.hostname ? proxyLocation(config) : ''}  location = /hub-config.json {
    add_header Cache-Control "no-store" always;
    try_files $uri =404;
  }
  location / { try_files $uri $uri/ /index.html; }
}
`
  );
}

export function deploymentGuide(config, metadata) {
  const hostname = new URL(config.daemonUrl).hostname;
  return `# Deploy hosted Qortal Hub

Build: ${metadata.releaseId} (source ${metadata.sourceCommit || 'source archive'}${metadata.sourceDirty ? '+dirty' : ''})
Frontend: ${config.origin}
Daemon: ${config.daemonUrl}
Core used by daemon: ${config.coreUrl}
Backend binary: ${metadata.platform}-${metadata.arch}

No deployment was performed by the build. Normal browser wallet login is used;
External Auth is optional. Serve ONLY www/ publicly. Keep daemon/, backend/,
environment files and account data outside the website document root.

1. Frontend on CyberPanel

Copy the CONTENTS of www/, including .htaccess, into the site's document root.
hub-config.json already points at ${config.daemonUrl}; no manual URL edit is needed.
Confirm ${config.origin}/hub-config.json returns that JSON, not HTTP 404 or HTML.
A plain dist/ upload omits this generated file and leaves browser chat and the
hosted Q-App viewer disabled. Publish www/ in full, not just its assets.
Enable rewrite rules and loading .htaccess. Retain existing site/TLS settings.
Read frontend/cyberpanel.txt for the required Header Operations. OpenLiteSpeed
does not apply Apache Header directives from .htaccess.
If using Nginx instead, adapt frontend/nginx.conf (root/certificates).

2. Backend VM (for example ai-devrig-2)

Copy this package, or at least daemon/ and backend/ together, to a PRIVATE
directory on the VM. It must match the binary OS/architecture above.
Install Node >=22.12/npm, Python >=3.9 with venv/pip support, Git and systemd.
Python's venv support is commonly provided by python3-venv on Debian/Ubuntu;
native SQLite may need a compiler/make toolchain when no prebuilt module exists.
Core at ${config.coreUrl} must be reachable FROM THE VM.

Inspect daemon/hosted.env, then from the copied package directory run:

    ./backend/install-backend.sh --dry-run
    sudo ./backend/install-backend.sh

The installer creates a dedicated qortal-hub account, installs npm/Python runtime
dependencies into a versioned release, enables/restarts qortal-hub-daemon.service,
and checks local HTTP plus origin-bound WebSocket readiness. It does not install
OS packages, change DNS/firewalls, or install/reload a web server.

Default paths:
  /srv/qortal-hub/releases/${metadata.releaseId}/
  /srv/qortal-hub/current -> active release
  /etc/qortal-hub/hosted.env (preserved on reruns)
  /var/lib/qortal-hub-daemon (persistent identities, history and resources)

Custom paths/account/service: see ./backend/install-backend.sh --help.
An unmanaged existing unit is refused; migrate it explicitly or choose another
service name AND install/data/env paths and listener ports. Do not start another
instance with an existing daemon's data directory or Reticulum ports.
For an intentional config change, --replace-config backs up and updates managed
settings while retaining unrelated settings such as External Auth configuration.

3. TLS and public WebSocket on the backend

Point ${hostname} at the VM. Use valid HTTPS certificates and preserve SSH access.
Expose HTTPS 443; use port 80 if required by your chosen certificate renewal flow.
Keep 3192/3193 (or your configured private ports) off the public network.
Permit outbound DNS/HTTPS, Core, and the Reticulum bootstrap links (currently
TCP 4400/4444). The shared/control ports remain private.

Obtain a certificate for ${hostname} using the VM's existing ACME tooling before
enabling backend/nginx.conf. For a fresh VM with port 80 free, for example:

    sudo certbot certonly --standalone -d ${hostname}

Then install backend/nginx.conf as a dedicated Nginx virtual host, preserving
other sites. For Debian-style Nginx with an unused target name:

    sudo install -m 0644 backend/nginx.conf /etc/nginx/sites-available/qortal-hub-daemon
    sudo ln -s /etc/nginx/sites-available/qortal-hub-daemon /etc/nginx/sites-enabled/qortal-hub-daemon
    sudo nginx -t && sudo systemctl reload nginx

Use the host's supported certificate renewal hooks and test renewal. If the
frontend and daemon share one public hostname, use frontend/nginx.conf as ONE
combined vhost instead of installing two vhosts with the same server_name.

The proxy must retain the original Origin header, rewrite upstream Host to
127.0.0.1:${config.daemonPort}, and map ${new URL(config.daemonUrl).pathname} to
/realtime including query strings. Do not log that WebSocket location.
On a split deployment CyberPanel serves static files only; browsers connect
directly to the daemon VM. Its allowed origin stays ${config.origin}.

4. Verify and operate

    sudo systemctl status qortal-hub-daemon
    sudo journalctl -u qortal-hub-daemon -n 100 --no-pager
    node /srv/qortal-hub/current/backend/check-backend.mjs --local
    node /srv/qortal-hub/current/backend/check-backend.mjs

The last command first checks ${config.origin}/hub-config.json and its daemon URL,
then tests public TLS/WSS with the website Origin. Use --backend-only to check
public WSS before publishing the frontend. A challenge proves transport
readiness, not authenticated peer delivery. Log in at ${config.origin}
with two wallets, send group/DM messages, reconnect and check history, transfer a
file and test calls. Verify microphone permissions and NAT/TURN on your network.
${config.iceServers?.length ? 'Public ICE settings are included in hub-config.json.' : 'No ICE servers were supplied. Configure STUN/short-lived TURN credentials for WebRTC across NATs.'}
Never embed an application secret, seed, wallet password or private key in www/.

5. Update and recover

Build the next package from hosted-access and run its installer. It prepares the
release before switching the service and retains a private rollback snapshot.
An unsuccessful startup automatically restores the previous managed release.
To manually restore the previous backend release and configuration:

    sudo /srv/qortal-hub/current/backend/install-backend.sh --rollback

Use the same custom path/service flags if you used them for installation.
Persistent account data is retained. Keep the matching previous www/ deployment
to restore the frontend at the same time. Back up persistent data through your
normal service lifecycle; a code rollback does not undo database/data changes.
`;
}

export async function writeHostedDeployment(directory, config) {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  let sourceCommit = null;
  let sourceDirty = false;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    sourceDirty = Boolean(
      execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=normal'],
        {
          cwd: sourceRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim()
    );
  } catch {
    /* Source archives have no Git metadata. */
  }
  const metadata = {
    version: 1,
    releaseId: `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`,
    sourceCommit,
    sourceDirty,
    platform: process.platform,
    arch: process.arch,
    origin: config.origin,
    daemonUrl: config.daemonUrl,
    daemonPort: config.daemonPort,
    apiPort: config.apiPort,
    files: {},
  };
  async function hashFiles(relative) {
    for (const item of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) await hashFiles(name);
      else if (item.isFile() && name === 'daemon/hosted.env') continue;
      else if (item.isFile())
        metadata.files[name] = createHash('sha256')
          .update(await readFile(path.join(directory, name)))
          .digest('hex');
      else throw new Error(`Unexpected non-file in runtime package: ${name}`);
    }
  }
  await mkdir(path.join(directory, 'backend'), { recursive: true });
  await mkdir(path.join(directory, 'frontend'), { recursive: true });
  await writeFile(
    path.join(directory, 'daemon/hosted.env'),
    `QORTAL_HUB_API_HOST=127.0.0.1\nQORTAL_HUB_BROWSER_ENABLED=1\nQORTAL_HUB_BROWSER_PORT=${config.daemonPort}\nQORTAL_HUB_API_PORT=${config.apiPort}\nQORTAL_HUB_API_ORIGINS=${config.origin}\nQORTAL_HUB_CORE_URL=${config.coreUrl}\nQORTAL_HUB_DATA_DIR=/var/lib/qortal-hub-daemon\n`,
    { mode: 0o600 }
  );
  await hashFiles('daemon');
  await writeFile(
    path.join(directory, 'backend/deployment.json'),
    JSON.stringify(metadata, null, 2) + '\n'
  );
  for (const name of [
    'install-backend.sh',
    'install-backend.mjs',
    'check-backend.mjs',
  ]) {
    await cp(
      path.join(sourceRoot, 'scripts/hosted-backend', name),
      path.join(directory, 'backend', name)
    );
    await chmod(path.join(directory, 'backend', name), 0o755);
  }
  await writeFile(
    path.join(directory, 'backend/nginx.conf'),
    nginxBackend(config)
  );
  await writeFile(
    path.join(directory, 'backend/qortal-hub-daemon.service'),
    serviceUnit(parseInstallArgs([]), 'qortal-hub', '/usr/bin/node')
  );
  await writeFile(
    path.join(directory, 'frontend/nginx.conf'),
    nginxFrontend(config)
  );
  await writeFile(
    path.join(directory, 'nginx.conf'),
    new URL(config.daemonUrl).hostname === config.hostname
      ? nginxFrontend(config)
      : nginxBackend(config)
  );
  await writeFile(
    path.join(directory, 'www/.htaccess'),
    '# OpenLiteSpeed: rewrite rules only. Set response headers in the vhost context.\nRewriteEngine On\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule ^ index.html [L]\n'
  );
  await writeFile(
    path.join(directory, 'frontend/cyberpanel.txt'),
    `Serve www/ at ${config.origin}. Enable Rewrite and Auto Load from .htaccess.\nIn OpenLiteSpeed WebAdmin > Virtual Hosts > your site > Context > /, use Header Operations:\n\nset Cross-Origin-Opener-Policy same-origin\nset Cross-Origin-Embedder-Policy credentialless\nset X-Content-Type-Options nosniff\n\nFor a Static context with URI exp:^/hub-config[.]json$ and Location $DOC_ROOT/$0,\nset Accessible to Yes and use these Header Operations:\n\nunset Cache-Control\nset Cache-Control no-store\n\nAlso bypass any CDN/site cache for /hub-config.json. Retain other existing context settings.\nApply/reload through the site's normal CyberPanel/OpenLiteSpeed workflow.\nCheck with curl -I ${config.origin}/ and curl -I ${config.origin}/hub-config.json.\nThe daemon URL is ${config.daemonUrl}; split hosting needs no CyberPanel WebSocket proxy.\nOpenLiteSpeed reads rewrite rules, not Header directives, from .htaccess.\nReferences: https://docs.openlitespeed.org/config/headers/ and https://docs.openlitespeed.org/security/headers/\n`
  );
  const guide = deploymentGuide(config, metadata);
  await writeFile(path.join(directory, 'DEPLOY.md'), guide);
  await writeFile(path.join(directory, 'DEPLOY.txt'), guide);
  return metadata;
}
