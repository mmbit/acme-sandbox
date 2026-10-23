# The support chat's service (infra/products.py CARE): the engine in platform/care with the company's plug-in folder,
# built from the repo's root and laid out as in the repo
FROM node:24.22.1-alpine
# The claim photos' decoder (src/photos.ts): ImageMagick with the JPEG coder only (Alpine ships the other coders apart),
# and our policy where ImageMagick 7 reads it, so every other coder and delegate is refused and one decode is bounded
RUN apk add --no-cache imagemagick imagemagick-jpeg
COPY platform/care/magick/policy.xml /etc/ImageMagick-7/policy.xml
WORKDIR /app
# The engine, where the plug-in imports it from (../../../platform/care/src/ from products/care/src/)
COPY platform/care/package.json ./platform/care/
COPY platform/care/src ./platform/care/src
COPY platform/care/public ./platform/care/public
COPY platform/care/magick ./platform/care/magick
# The frame header's size reader, shared with the company site
COPY shared/pictures/size.ts ./shared/pictures/size.ts
# The client by its network, shared with the shops' limits
COPY shared/net/net.ts ./shared/net/net.ts
# The phone's route table, and the web kit's
COPY shared/routes/routes.ts ./shared/routes/routes.ts
# Money and days in the customer's language: the formats engine, and the company's kits that bind it to its own (the
# plug-in imports them by their paths in the repo).
COPY shared/format/format.js ./shared/format/format.js
# The holidays' dates, which the company's holiday kit reads
COPY shared/holidays/holidays.js ./shared/holidays/holidays.js
# The order numbers' check digit, which the plug-in reads a said order number by
COPY shared/ordernumber/ordernumber.js ./shared/ordernumber/ordernumber.js
COPY kits ./kits
# The company's plug-in, which the engine finds through CARE_COMPANY_DIR: the whole folder in one copy, so a plug-in
# without one of its parts (care.ts, src/, public/, kb/, apps/ are each optional: src/company.ts) still builds; what of it
# goes in is Dockerfile.dockerignore's list, without tests, demo or eval
COPY products/care ./products/care
ENV CARE_COMPANY_DIR=/app/products/care
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "platform/care/src/server.ts"]
