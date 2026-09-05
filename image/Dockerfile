FROM quay.io/jupyter/minimal-notebook:latest

USER root
RUN apt-get update \
 && apt-get install --yes --no-install-recommends curl openssh-server \
 && rm -rf /var/lib/apt/lists/*
COPY THIRD_PARTY_NOTICES.md /usr/local/share/licenses/nfdi-sandbox/THIRD_PARTY_NOTICES.md

USER ${NB_UID}
RUN python3 -m pip install --no-cache-dir \
    "jupyter-server-proxy>=4.3.0,<5" \
    "jupyter-sshd-proxy==0.3.0"

# Jupyter4NFDI invokes jupyterhub-singleuser. jupyter-sshd-proxy's entry point
# registers /sshd/ as an authenticated raw WebSocket -> loopback TCP proxy.
