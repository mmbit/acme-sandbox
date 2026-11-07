# This server's own run helper, one per kind of run (infra/run_helpers.py): the kind's image (IMAGE) with the code a lent
# machine's start command runs, so runs go the same way on both. A changed helper.mjs rebuilds it. The image's own user
# and entrypoint are replaced, as the start command replaces them.
ARG IMAGE=node:24.22.1-slim
FROM ${IMAGE}
COPY helper.mjs manager.mjs /opt/helper/
USER 0:0
# A fresh Docker volume at /work (this server's) copies this folder's mode. Every run's user may write in it, and only
# a file's owner may remove it, as on the lent machines' in-memory /work (mode 1777).
RUN mkdir -p /work && chmod 1777 /work
ENTRYPOINT ["node", "/opt/helper/helper.mjs"]
