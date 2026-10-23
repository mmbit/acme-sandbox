# This server's own run helper, one per kind of run (infra/run_helpers.py): the kind's image (IMAGE) with the code a lent
# machine's start command runs, so runs go the same way on both. A changed helper.mjs rebuilds it. The image's own user
# and entrypoint are replaced, as the start command replaces them.
ARG IMAGE=node:24.22.1-slim
FROM ${IMAGE}
COPY helper.mjs /opt/helper/helper.mjs
USER 0:0
ENTRYPOINT ["node", "/opt/helper/helper.mjs"]
