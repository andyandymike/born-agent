ARG BORN_BASE_IMAGE=bornagent-invalid:denied
FROM ${BORN_BASE_IMAGE}

ARG BORN_ARTIFACT_LOCK_SHA256

LABEL org.bornagent.runtime="node" \
      org.bornagent.runtime-version="22.22.0" \
      org.bornagent.image-policy-version="phase13-docker-v1" \
      org.bornagent.exec-wrapper-sha256="d097ea4c278c2ccdb921db51a7f6052af8841a00928faa570fcdb0cf9fc897f4" \
      org.bornagent.lockfile-sha256="${BORN_ARTIFACT_LOCK_SHA256}" \
      org.bornagent.artifact-id="bornagent-sandbox-node-v1"

COPY --chmod=0555 context/born-sandbox-exec /usr/local/bin/born-sandbox-exec
RUN mkdir -p /workspace /home/born && chown 10001:10001 /workspace /home/born

ENV HOME=/home/born \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin

WORKDIR /workspace
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/born-sandbox-exec"]
