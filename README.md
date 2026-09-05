# nfdi-sandbox

A minimal Node.js client and CLI that treats a Jupyter4NFDI server as an agent
sandbox. It supports lifecycle management, command execution, file transfer,
and real OpenSSH transported through JupyterHub's existing HTTPS/WebSocket
ingress.

This is a working prototype, not a published npm package or production-hardened
service.

[![CI](https://github.com/arnim/nfdi-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/arnim/nfdi-sandbox/actions/workflows/ci.yml)
[![Full E2E](https://github.com/arnim/nfdi-sandbox/actions/workflows/e2e.yml/badge.svg)](https://github.com/arnim/nfdi-sandbox/actions/workflows/e2e.yml)

## Tests and GitHub Actions

Like `nbverify`, fast checks and a local smoke test run on pushes to `main`,
pull requests, and manual dispatch. Fast checks cover Node 20, 22, and 24. The
smoke job builds our Dockerfile and exercises the Jupyter APIs and real OpenSSH:
authentication, host-key verification, PTY allocation, and binary SCP/SFTP.

The Full E2E workflow runs daily at 03:47 UTC or on manual dispatch from `main`.
It tests Jupyter4NFDI custom-image and Repo2Docker launches sequentially, including
exec, files, stop, and destroy. The custom-image test also checks SSH. Live SSH
uses the public Pangeo test image; CI separately builds and tests our Dockerfile.
The plain Repo2Docker fixture does not include SSH, so that canary tests only
Jupyter APIs and lifecycle. Missing credentials fail explicitly.

```bash
npm ci
npm run test:fast
docker build -f image/Dockerfile -t nfdi-sandbox:test .
npm run test:e2e:local
NFDI_E2E_SOURCE=image npm run test:e2e:jupyter4nfdi
NFDI_E2E_SOURCE=repo2docker npm run test:e2e:jupyter4nfdi
npm run test:e2e:cleanup
```

Live tests read the repository Actions secret `JUPYTER4NFDI_TOKEN`, only on the
nightly/manual workflow. PR checks do not receive it. Tests generate temporary
SSH identities and pin the host key obtained over authenticated HTTPS. Pending
session metadata is saved immediately so cleanup can destroy a server even if
provisioning or testing fails. Both the runner's `finally` block and a separate
`always()` workflow step perform cleanup and verify remote deletion. The runner
state is in ignored `work/e2e/` locally and in the disposable GitHub checkout.
Do not run concurrent local tests against the same state directory; override
`NFDI_E2E_STATE_DIR` to isolate runs. A lost runner or forced job termination can
still prevent cleanup; remove any surviving `nfdi-e2e-*` configuration in the
Jupyter4NFDI UI. State files and SSH keys are never uploaded as workflow artifacts.

## What works

- Create from a Jupyter-compatible custom image.
- Create from a public GitHub repository with Jupyter4NFDI Repo2Docker.
- Poll status and retain the server URL and lifecycle URLs.
- Execute shell commands through the authenticated Jupyter Terminals and
  Contents APIs, with separate stdout/stderr, exit status, and a hard timeout.
- Upload, download, list, create, and recursively delete files through the
  Jupyter Contents API. Binary files use base64 and are byte preserving.
- Stop compute while retaining the Jupyter4NFDI configuration.
- Destroy compute and remove the configuration with `{"remove": true}`.
- Use OpenSSH, SFTP, and SCP through an authenticated WebSocket without exposing
  port 22 and without installing `websocat` locally.

## Install

Requires Node.js 20 or newer.

```bash
npm install
npm link
export JUPYTER4NFDI_TOKEN='...'
```

Create tokens at <https://hub.nfdi-jupyter.de/hub/token>. The CLI reads the
token from the environment for every operation. It deliberately does not store
the token in its local session files.

## Create and use a sandbox

Custom image:

```bash
nfdi-sandbox create \
  --image ghcr.io/my-org/nfdi-agent-sandbox:v1 \
  --name my-agent \
  --ssh-key ~/.ssh/id_ed25519.pub
```

Repo2Docker:

```bash
nfdi-sandbox create \
  --repo https://github.com/my-org/my-analysis \
  --ref 0123456789abcdef \
  --name my-analysis
```

The command prints a short local ID. Use it for subsequent commands:

```bash
nfdi-sandbox status 8f4c6a21
nfdi-sandbox exec 8f4c6a21 -- 'python analysis.py'
nfdi-sandbox files put 8f4c6a21 ./input.csv input.csv
nfdi-sandbox files get 8f4c6a21 results.json ./results.json
nfdi-sandbox files ls 8f4c6a21
nfdi-sandbox stop 8f4c6a21
nfdi-sandbox destroy 8f4c6a21
```

`stop` retains the remote server configuration; `destroy` removes it. A stopped
sandbox is not currently restartable through this minimal client—create a new
sandbox or use the Jupyter4NFDI UI.

## SSH

The server image must contain OpenSSH, `jupyter-server-proxy>=4.3`, and
`jupyter-sshd-proxy`. Build [image/Dockerfile](image/Dockerfile) from the project
root (`docker build -f image/Dockerfile .`) and publish it, or
use equivalent packages in your own image. The image still runs
`jupyterhub-singleuser`, as required by Jupyter4NFDI.

Authorize a key during creation, or later:

```bash
nfdi-sandbox ssh-authorize 8f4c6a21 ~/.ssh/id_ed25519.pub
nfdi-sandbox ssh 8f4c6a21 -- uname -a
```

For normal OpenSSH tooling, write the generated stanza to `~/.ssh/config`:

```bash
nfdi-sandbox ssh-config 8f4c6a21 >> ~/.ssh/config
ssh nfdi-8f4c6a21
scp ./data.csv nfdi-8f4c6a21:/home/jovyan/data.csv
rsync -av ./project/ nfdi-8f4c6a21:/home/jovyan/project/
```

The generated stanza is:

```sshconfig
Host nfdi-8f4c6a21
    HostName hub.nfdi-jupyter.de
    User jovyan
    ProxyCommand nfdi-sandbox ssh-proxy 8f4c6a21
    IdentitiesOnly yes
```

The transport is:

```text
OpenSSH client
  -> ProxyCommand stdin/stdout
  -> nfdi-sandbox authenticated WSS
  -> /user/<name>/<server>/sshd/
  -> jupyter-server-proxy raw_socket_proxy
  -> 127.0.0.1:<unprivileged random port>
  -> sshd running as jovyan
```

There are two authentication layers: the JupyterHub API token authenticates the
WebSocket request, and the authorized SSH key authenticates the SSH connection.
The SSH TCP listener is loopback-only and is not publicly exposed.

### Repo2Docker with SSH

The SSH server-proxy entry point must be installed before Jupyter starts. Merge
the files in [examples/repo2docker-ssh](examples/repo2docker-ssh) into the
repository's active Repo2Docker configuration directory (`binder/`, `.binder/`,
or the repository root). If the repository already has `apt.txt` or
`requirements.txt`, append the listed packages rather than replacing its files.

Current Jupyter4NFDI documentation says only public GitHub repositories are
supported by its Repo2Docker option. For reproducibility, prefer a commit hash
over a moving branch.

## SDK

```js
import { Jupyter4NFDIClient } from 'nfdi-sandbox';

const client = new Jupyter4NFDIClient({
  token: process.env.JUPYTER4NFDI_TOKEN,
});

const sandbox = await client.create({
  image: 'ghcr.io/my-org/nfdi-agent-sandbox:v1',
  name: 'my-agent',
});

const result = await sandbox.exec('python -V');
await sandbox.files.write('input.json', JSON.stringify({ value: 42 }));
const output = await sandbox.files.read('output.json');
await sandbox.stop();
await sandbox.destroy();
```

Use `{ repo: 'OWNER/REPO', ref: '<commit>' }` instead of `image` for
Repo2Docker. `create()` accepts `onUpdate(session)` so callers can persist the
pending lifecycle URLs immediately and display status changes.

## Security and operational limits

- Use short-lived JupyterHub tokens where possible and never put a token
  directly into `~/.ssh/config`; the ProxyCommand reads it from the environment.
- Pin immutable container digests and Git commits for production use. The
  example Dockerfile's `latest` base is convenient for the prototype only.
- Require `jupyter-server-proxy>=4.3.0`. Versions `<=4.1.0` had a critical
  WebSocket authentication bypass; patched versions begin at `4.1.1`.
- A custom image can enable SSH today with no public port and no Jupyter4NFDI
  change. Enabling SSH for arbitrary existing images would require Jupyter4NFDI
  to inject the packages/configuration or provide a managed sidecar.
- The public test image used during validation emitted a harmless warning when
  unprivileged `sshd` could not write `/var/run/sshd.pid`; it still bound only to
  loopback and handled OpenSSH/SCP successfully.
- The prototype stores non-secret session metadata in
  `$XDG_STATE_HOME/nfdi-sandbox` (normally `~/.local/state/nfdi-sandbox`) with
  mode `0600`.

See [docs/validation.md](docs/validation.md) for the live test record and source
links, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for license notes.
