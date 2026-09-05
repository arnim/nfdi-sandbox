# Architecture and validation record

Validated on 2026-09-05 against the live Jupyter4NFDI service.

## Documentation-backed assumptions

Jupyter4NFDI's current REST documentation specifies:

- `POST /hub/api/start` with either `option: custom` and
  `custom.customimage`, or `option: repo2docker` and its repository fields.
- `200` for an already-running server and `202` for a pending start.
- polling the returned `status_url` and using the returned `next_url` as the
  Jupyter Server base URL.
- plain `DELETE delete_url` to stop and `DELETE` with `{"remove": true}` to
  stop and remove the saved configuration.

Sources:

- [Jupyter4NFDI REST API](https://nfdi-jupyter.de/users/rest-api/)
- [Jupyter4NFDI custom-image requirements](https://nfdi-jupyter.de/users/jupyterlab/customdockerimage/)
- [Jupyter4NFDI Repo2Docker](https://nfdi-jupyter.de/users/jupyterlab/repo2docker/)

The current Jupyter Server Proxy documentation defines `raw_socket_proxy` as a
WebSocket-only proxy whose messages are forwarded as a raw TCP or Unix-socket
stream. Named server processes are registered before Jupyter Server starts and
are exposed below the notebook server base URL. `jupyter-sshd-proxy` packages
this configuration for OpenSSH: it creates a per-user host key, launches `sshd`
on a random loopback port as the notebook user, enables internal SFTP, and
registers the named `/sshd/` route.

Sources:

- [Jupyter Server Proxy server-process configuration](https://jupyter-server-proxy.readthedocs.io/en/latest/server-process.html)
- [`jupyter-sshd-proxy`](https://github.com/yuvipanda/jupyter-sshd-proxy)
- [WebSocket authentication advisory and patched versions](https://github.com/jupyterhub/jupyter-server-proxy/security/advisories/GHSA-w3vc-fx9p-wp4v)

## Live test

The test used the existing public image
`quay.io/yuvipanda/pangeo-jupyter-sshd-proxy:latest` as a disposable
Jupyter4NFDI custom image. The user's API token remained in the environment and
was not printed or saved.

Observed results:

1. The start call returned a pending lifecycle record and reached `running`
   after the image pull and server startup.
2. The authenticated status endpoint returned the running `next_url`.
3. Command execution returned `jovyan`, exit code 0, and reported
   `jupyter-server-proxy` 4.3.0.
4. A binary-safe Contents API upload/download round trip was byte-identical.
5. The client installed an existing local Ed25519 public key into
   `/home/jovyan/.ssh/authorized_keys` with safe permissions.
6. macOS OpenSSH 10.3 completed host-key exchange and public-key authentication
   through the authenticated WSS `/sshd/` route. A remote command returned the
   exact marker `SSH_OK`.
7. `scp` (using its SFTP transport) uploaded `package.json`; a subsequent
   Contents API download was byte-identical to the original.
8. A plain delete stopped the server and status became `stopped`.
9. A delete with `{"remove": true}` destroyed the server configuration. The
   disposable local session metadata was removed.

A second disposable launch used the documented Repo2Docker payload with the
public `binder-examples/requirements` GitHub repository at `HEAD`. It reached
`running`, executed `pwd; python3 -V` successfully in `/home/jovyan`, completed
another byte-identical Contents API file round trip, stopped, and was destroyed.
This live run also reproduced Jupyter4NFDI's short start race: the start response
was `pending`, the first status poll was transiently `stopped`, and a later poll
returned `pending`. The client now has an explicit 30-second grace period and a
regression test for that sequence.

No public TCP port was opened. Jupyter Server logs showed the raw socket proxy
connecting to a random loopback port and OpenSSH accepting the Ed25519 key for
`jovyan`.

## What needs platform work

Nothing on the Jupyter4NFDI side is required when users opt into an SSH-capable
custom image or include the packages in their Repo2Docker repository. The
existing authenticated Jupyter/JupyterHub route carries the WebSocket.

Platform work is required only if the product goal is “SSH for every arbitrary
image” without user image changes. The platform would need to inject OpenSSH
plus the server-proxy entry point before `jupyterhub-singleuser` starts, or run
an equivalent managed sidecar and register an authenticated raw route. That
would need a security review, version enforcement, resource limits, and a clear
host-key persistence policy.

## Remaining production-hardening work

- Publish and pin a small maintained image by digest instead of using the large
  mutable Pangeo test image.
- Add CI against that image and a controlled JupyterHub fixture.
- Decide whether host keys should persist across stops. A recreated environment
  with a new host key can trigger an expected `known_hosts` warning.
- Add bounded output/file sizes and cancellation semantics suitable for
  untrusted agents.
- Add token expiry/refresh handling and redact any provider-specific spawn logs
  before exposing them to multi-tenant callers.
- Confirm Jupyter4NFDI's intended API stability/support contract; its current
  public page documents behavior but does not publish a versioned schema.
